// 无本地数据库（IndexedDB）可用时的内存保存路径：写入再读出的往返结果
// 失败定位约定：
//   断言名含「存储」→ 内存降级层没写进去 / 读出不一致 / 删除清空不生效
//   断言名含「往返」→ 重新 init 装载后数据丢失或错位
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AppStore } from '../src/lib/store';
import * as idb from '../src/lib/idb';
import type { AppSettings, OnsiteRecord, Riddle } from '../src/types';

beforeEach(() => {
  idb.__resetForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('idb 内存降级层 · 直接读写往返', () => {
  it('【存储】put → getAll：对象原样返回（含 no/check 等完整字段）', async () => {
    const r: Riddle = {
      id: 'r1', no: 42, surface: '谜面往返', answer: '答', category: 'char', format: 'none',
      difficulty: 1, tags: ['标签甲', '标签乙'],
      check: { verdict: 'fail', reasons: ['谜底为空，无法校验'], checkedAt: 123 },
    };
    await idb.put(idb.STORE_RIDDLES, r);
    const all = await idb.getAll<Riddle>(idb.STORE_RIDDLES);
    expect(all).toHaveLength(1);
    expect(all[0]).toEqual(r);
  });

  it('【存储】同 id 再次 put 是覆盖而非新增', async () => {
    await idb.put(idb.STORE_RIDDLES, { id: 'k', v: 1 } as unknown as Riddle);
    await idb.put(idb.STORE_RIDDLES, { id: 'k', v: 2 } as unknown as Riddle);
    const all = await idb.getAll<{ id: string; v: number }>(idb.STORE_RIDDLES);
    expect(all).toHaveLength(1);
    expect(all[0].v).toBe(2);
  });

  it('【存储】del / clearStore 生效，不同 store 互不干扰', async () => {
    await idb.put(idb.STORE_RIDDLES, { id: 'r1' } as unknown as Riddle);
    await idb.put(idb.STORE_RECORDS, { id: 'x1' } as unknown as OnsiteRecord);
    await idb.del(idb.STORE_RIDDLES, 'r1');
    expect(await idb.getAll(idb.STORE_RIDDLES)).toEqual([]);
    expect(await idb.getAll(idb.STORE_RECORDS)).toHaveLength(1);
    await idb.clearStore(idb.STORE_RECORDS);
    expect(await idb.getAll(idb.STORE_RECORDS)).toEqual([]);
  });

  it('【存储】putMany 批量写入；setKV/getKV 往返', async () => {
    await idb.putMany(idb.STORE_RIDDLES, [
      { id: 'a', no: 1 }, { id: 'b', no: 2 },
    ] as unknown as Riddle[]);
    expect((await idb.getAll<Riddle>(idb.STORE_RIDDLES)).map((r) => r.id).sort()).toEqual(['a', 'b']);
    await idb.setKV('settings', { event: { title: '灯会' } });
    expect(await idb.getKV<{ event: { title: string } }>('settings'))
      .toEqual({ event: { title: '灯会' } });
    expect(await idb.getKV('不存在的键')).toBeNull();
  });
});

describe('store · 内存保存路径写入 → 重新 init 读出的往返', () => {
  it('【往返】谜库/登记/设置经内存保存后，新 store init 装载结果与写入一致且按序排列', async () => {
    // init 会 fetch 离线数据包，Node 下没有服务；桩成 404，ctx 退化为 EMPTY_CTX
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));

    const s1 = new AppStore();
    const r1 = await s1.saveRiddle({
      surface: '第一条', answer: '甲', category: 'char', format: 'none',
      difficulty: 1, tags: [],
    });
    const r2 = await s1.saveRiddle({
      surface: '第二条', answer: '乙', category: 'char', format: 'none',
      difficulty: 2, tags: [],
    });
    await s1.addRecord({ riddleId: r1.id, winnerName: '张三', prize: '一等奖', at: 5000 });
    await s1.addRecord({ riddleId: r2.id, winnerName: '李四', prize: '', at: 3000 });
    await s1.saveSettings({ event: { title: '往返灯会', host: '主办方', riddleIds: [r1.id] } } as Partial<AppSettings>);

    // 全新 store 实例（模拟刷新页面），init 从内存层装回
    const s2 = new AppStore();
    await s2.init();
    const riddles = s2.getState().riddles;
    expect(riddles.map((r) => r.no)).toEqual([1, 2]);
    expect(riddles.map((r) => r.surface)).toEqual(['第一条', '第二条']);
    // 登记按 at 倒序（新的在前）
    expect(s2.getState().records.map((x) => x.at)).toEqual([5000, 3000]);
    expect(s2.getState().settings.event.title).toBe('往返灯会');
    expect(s2.getState().settings.event.host).toBe('主办方');
    expect(s2.getState().settings.event.riddleIds).toEqual([r1.id]);
    // 装回后还能继续工作：统计与下一个谜号
    expect(s2.nextNo()).toBe(3);
    expect(s2.stats()).toMatchObject({ total: 2, solved: 2, remaining: 0, prizes: 1 });
    // 装回后再写一条，真正持久化回同一内存层
    const r3 = await s2.saveRiddle({
      surface: '第三条', answer: '丙', category: 'char', format: 'none',
      difficulty: 3, tags: [],
    });
    expect(r3.no).toBe(3);
    expect((await idb.getAll<Riddle>(idb.STORE_RIDDLES)).map((r) => r.no).sort((a, b) => a - b))
      .toEqual([1, 2, 3]);
  });
});
