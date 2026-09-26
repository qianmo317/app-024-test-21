// 谜库状态流转测试：谜号分配 / 保存时重算校验 / 批量导入编号 /
// 批量删除与活动清单同步 / 清空后重新编号
// 失败定位约定：
//   断言名含「编号」→ 编号算错（nextNo / addRiddles 分配）
//   断言名含「重算」→ 保存时校验没重算（check 未刷新）
//   断言名含「存储」→ idb 内存层没落盘或读出不一致
import { describe, it, expect, beforeEach } from 'vitest';
import { AppStore } from '../src/lib/store';
import * as idb from '../src/lib/idb';
import type { AppSettings, Riddle } from '../src/types';

type RiddlePatch = Parameters<AppStore['saveRiddle']>[0];

function riddlePatch(over: Partial<RiddlePatch> = {}): RiddlePatch {
  return {
    surface: '谜面', answer: '谜底',
    category: 'other', format: 'none',
    difficulty: 2, tags: [],
    ...over,
  } as RiddlePatch;
}

let uniq = 0;
function rp(over: Partial<RiddlePatch> = {}): RiddlePatch {
  uniq += 1;
  return riddlePatch({ surface: `谜面${uniq}`, ...over });
}

beforeEach(() => {
  idb.__resetForTests(); // 每个用例全新的内存库
});

describe('谜库 · 谜号分配（编号算错看这里）', () => {
  it('【编号】空库第一条谜号为 1（保存前 nextNo 也是 1）', async () => {
    const store = new AppStore();
    expect(store.nextNo()).toBe(1);
    const r = await store.saveRiddle(rp());
    expect(r.no).toBe(1);
    expect(store.nextNo()).toBe(2);
  });

  it('【编号】删除中间几条后再新增：新号接在最大号之后，不回收已删除的空号', async () => {
    const store = new AppStore();
    const [a, b, c] = await Promise.all([rp(), rp(), rp()].map((p) => store.saveRiddle(p)));
    expect([a.no, b.no, c.no]).toEqual([1, 2, 3]);
    await store.removeRiddles([b.id]); // 删掉 2 号
    expect(store.getState().riddles.map((r) => r.no)).toEqual([1, 3]);
    expect(store.nextNo()).toBe(4);
    const d = await store.saveRiddle(rp());
    expect(d.no).toBe(4); // 不是复用 2
  });

  it('【编号】同一条反复保存谜号不变（id 也不变，check 每次重算）', async () => {
    const store = new AppStore();
    const r = await store.saveRiddle(rp());
    const firstNo = r.no;
    const firstCheckedAt = r.check.checkedAt;
    await new Promise((res) => setTimeout(res, 2));
    for (let i = 0; i < 3; i++) {
      const saved = await store.saveRiddle(rp({ id: r.id, surface: `改了谜面${i}`, answer: '新谜底' }));
      expect(saved.id).toBe(r.id);
      expect(saved.no).toBe(firstNo);
    }
    // 仍是同一条，没有被当成新增
    expect(store.getState().riddles).toHaveLength(1);
    expect(store.getState().riddles[0].check.checkedAt).toBeGreaterThanOrEqual(firstCheckedAt);
  });

  it('【编号】批量导入：自带谜号与自动编号混用时，自动号跳过已占用号（含本批自带号）', async () => {
    const store = new AppStore();
    await Promise.all([rp(), rp(), rp()].map((p) => store.addRiddles([p])));
    expect(store.nextNo()).toBe(4);
    // 顺序：自带 5 → 自动 → 自带 7 → 自动
    await store.addRiddles([
      rp({ no: 5 }),
      rp(),
      rp({ no: 7 }),
      rp(),
    ]);
    const nos = store.getState().riddles.map((r) => r.no).sort((x, y) => x - y);
    expect(new Set(nos).size).toBe(nos.length); // 无重号
    expect(nos).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('【编号】批量导入空数组返回 0，不产生任何编号', async () => {
    const store = new AppStore();
    expect(await store.addRiddles([])).toBe(0);
    expect(store.getState().riddles).toHaveLength(0);
    expect(store.nextNo()).toBe(1);
  });

  it('【编号】批量导入全不带号：从 nextNo 起连续编号', async () => {
    const store = new AppStore();
    await store.addRiddles([rp(), rp(), rp(), rp()]);
    expect(store.getState().riddles.map((r) => r.no)).toEqual([1, 2, 3, 4]);
  });

  it('【编号】清空后再导入，编号从 1 重新开始', async () => {
    const store = new AppStore();
    await store.addRiddles([rp(), rp(), rp()]);
    await store.clearRiddles();
    expect(store.getState().riddles).toHaveLength(0);
    expect(store.nextNo()).toBe(1);
    await store.addRiddles([rp(), rp()]);
    expect(store.getState().riddles.map((r) => r.no)).toEqual([1, 2]);
  });
});

describe('谜库 · 保存时重算校验（重算漏了看这里）', () => {
  it('【重算】保存修改后 check 按新内容重新判定：合法谜底改成多字「猜一字」应判不通过', async () => {
    const store = new AppStore();
    const r = await store.saveRiddle(rp({ category: 'char', answer: '白' }));
    expect(r.check.verdict).not.toBe('fail');
    const again = await store.saveRiddle(rp({ id: r.id, category: 'char', answer: '白云', surface: r.surface }));
    expect(again.no).toBe(1);
    expect(again.check.verdict).toBe('fail');
    expect(again.check.reasons.join(' ')).toContain('1 个字');
  });

  it('【重算】批量导入的每条都带本次校验结果（空谜底直接判不通过）', async () => {
    const store = new AppStore();
    await store.addRiddles([rp({ answer: '甲' }), rp({ answer: '' })]);
    const [ok, bad] = store.getState().riddles;
    expect(ok.check.verdict).not.toBe('fail');
    expect(bad.check.verdict).toBe('fail');
    expect(bad.check.reasons.join(' ')).toContain('谜底');
  });

  it('【重算】recheckAll 重刷全库校验时间且不改谜号', async () => {
    const store = new AppStore();
    const before = Date.now() - 10;
    await store.addRiddles([rp(), rp()]);
    await store.recheckAll();
    const riddles = store.getState().riddles;
    expect(riddles.map((r) => r.no)).toEqual([1, 2]);
    expect(riddles.every((r) => r.check.checkedAt >= before)).toBe(true);
  });
});

describe('谜库 · 删除 / 清空 与活动清单同步（存储没写进去看这里）', () => {
  it('【存储】删除谜条：内存状态、idb 持久层、活动清单 riddleIds 三处同步去掉', async () => {
    const store = new AppStore();
    const [a, b, c] = await Promise.all([rp(), rp(), rp()].map((p) => store.saveRiddle(p)));
    await store.saveSettings({ event: { riddleIds: [a.id, b.id, c.id] } } as Partial<AppSettings>);
    await store.removeRiddles([a.id, c.id]);
    // 内存状态
    expect(store.getState().riddles.map((r) => r.id)).toEqual([b.id]);
    // 活动清单同步
    expect(store.getState().settings.event.riddleIds).toEqual([b.id]);
    // idb 持久层（riddles 表）
    const persisted = await idb.getAll<Riddle>(idb.STORE_RIDDLES);
    expect(persisted.map((r) => r.id).sort()).toEqual([b.id]);
    // idb 持久层（kv 里的设置）
    const settings = await idb.getKV<{ event: { riddleIds: string[] } }>('settings');
    expect(settings?.event.riddleIds).toEqual([b.id]);
  });

  it('【存储】删除不在库中的 id 不报错，也不影响活动清单里的其他项', async () => {
    const store = new AppStore();
    const a = await store.saveRiddle(rp());
    await store.saveSettings({ event: { riddleIds: [a.id] } } as Partial<AppSettings>);
    await expect(store.removeRiddles(['不存在的id'])).resolves.toBeUndefined();
    expect(store.getState().riddles).toHaveLength(1);
    expect(store.getState().settings.event.riddleIds).toEqual([a.id]);
  });

  it('【存储】清空谜库：riddles 表与活动清单都清空并落盘', async () => {
    const store = new AppStore();
    const [a, b] = await Promise.all([rp(), rp()].map((p) => store.saveRiddle(p)));
    await store.saveSettings({ event: { riddleIds: [a.id, b.id] } } as Partial<AppSettings>);
    await store.clearRiddles();
    expect(await idb.getAll(idb.STORE_RIDDLES)).toEqual([]);
    expect(store.getState().settings.event.riddleIds).toEqual([]);
    const settings = await idb.getKV<{ event: { riddleIds: string[] } }>('settings');
    expect(settings?.event.riddleIds).toEqual([]);
  });
});
