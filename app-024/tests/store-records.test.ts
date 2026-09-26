// 现场登记状态流转测试：登记写入 / 删除 / 兑奖号码生成 / 实时统计
// 失败定位约定：
//   断言名含「编号」→ 兑奖号码生成算错（DJ-xxxx 补号/重复）
//   断言名含「统计」→ stats 实时统计口径错（空白奖品名等）
//   断言名含「存储」→ idb 内存层没落盘或读出不一致
import { describe, it, expect, beforeEach } from 'vitest';
import { AppStore } from '../src/lib/store';
import * as idb from '../src/lib/idb';
import type { OnsiteRecord, Riddle } from '../src/types';

function riddlePatch(i: number) {
  return {
    surface: `谜面${i}`, answer: '谜底', category: 'other' as const,
    format: 'none' as const, difficulty: 2 as const, tags: [],
  };
}

beforeEach(() => {
  idb.__resetForTests();
});

async function seedRiddle(store: AppStore, i: number): Promise<Riddle> {
  return store.saveRiddle(riddlePatch(i));
}

describe('登记 · 写入与删除（存储没写进去看这里）', () => {
  it('【存储】同一谜号登记两次：存储层两条记录都保留（统计按谜号去重，记录数为 2）', async () => {
    const store = new AppStore();
    const r = await seedRiddle(store, 1);
    const rec1 = await store.addRecord({ riddleId: r.id, winnerName: '张三', prize: '一等奖', at: 1000 });
    const rec2 = await store.addRecord({ riddleId: r.id, winnerName: '李四', prize: '参与奖', at: 2000 });
    expect(rec1.id).not.toBe(rec2.id);
    // 内存：两条，最新登记排在最前
    expect(store.getState().records.map((x) => x.id)).toEqual([rec2.id, rec1.id]);
    expect(store.recordsOf(r.id)).toHaveLength(2);
    // 存储层：同一 riddleId 两条都在（不覆盖、不丢）
    const persisted = await idb.getAll<OnsiteRecord>(idb.STORE_RECORDS);
    expect(persisted.filter((x) => x.riddleId === r.id)).toHaveLength(2);
  });

  it('【存储】删除登记：内存与存储层同步移除，同谜号另一条不受影响', async () => {
    const store = new AppStore();
    const r = await seedRiddle(store, 1);
    const keep = await store.addRecord({ riddleId: r.id, prize: '参与奖', at: 1000 });
    const gone = await store.addRecord({ riddleId: r.id, prize: '一等奖', at: 2000 });
    await store.removeRecord(gone.id);
    expect(store.getState().records.map((x) => x.id)).toEqual([keep.id]);
    const persisted = await idb.getAll<OnsiteRecord>(idb.STORE_RECORDS);
    expect(persisted.map((x) => x.id)).toEqual([keep.id]);
  });

  it('【存储】清空登记：内存与存储层都清空，谜库不受影响', async () => {
    const store = new AppStore();
    const r = await seedRiddle(store, 1);
    await store.addRecord({ riddleId: r.id, prize: '参与奖', at: 1000 });
    await store.clearRecords();
    expect(store.getState().records).toEqual([]);
    expect(await idb.getAll(idb.STORE_RECORDS)).toEqual([]);
    expect(store.getState().riddles).toHaveLength(1);
  });
});

describe('登记 · 兑奖号码生成（编号算错看这里）', () => {
  it('【编号】首次生成：按登记时间升序连续编号 DJ-0001 起，返回生成条数', async () => {
    const store = new AppStore();
    const r = await seedRiddle(store, 1);
    const late = await store.addRecord({ riddleId: r.id, prize: '一等奖', at: 3000 });
    const early = await store.addRecord({ riddleId: r.id, prize: '参与奖', at: 1000 });
    const mid = await store.addRecord({ riddleId: r.id, prize: '参与奖', at: 2000 });
    const n = await store.generatePrizeCodes();
    expect(n).toBe(3);
    const byId = new Map(store.getState().records.map((x) => [x.id, x.code]));
    expect(byId.get(early.id)).toBe('DJ-0001');
    expect(byId.get(mid.id)).toBe('DJ-0002');
    expect(byId.get(late.id)).toBe('DJ-0003');
  });

  it('【编号】第二次生成：已有号码保持不变，只给没有号码的新登记补号且不重号', async () => {
    const store = new AppStore();
    const r = await seedRiddle(store, 1);
    const r1 = await store.addRecord({ riddleId: r.id, prize: '参与奖', at: 1000 });
    const r2 = await store.addRecord({ riddleId: r.id, prize: '参与奖', at: 2000 });
    expect(await store.generatePrizeCodes()).toBe(2);
    expect(r1.code).toBe('DJ-0001');
    expect(r2.code).toBe('DJ-0002');

    // 新来两条还没有号码的登记
    const r3 = await store.addRecord({ riddleId: r.id, prize: '一等奖', at: 3000 });
    const r4 = await store.addRecord({ riddleId: r.id, prize: '参与奖', at: 4000 });
    const n = await store.generatePrizeCodes();
    expect(n).toBe(2);
    // 老号码不动
    expect(r1.code).toBe('DJ-0001');
    expect(r2.code).toBe('DJ-0002');
    // 新号顺延补齐，全库无重号
    expect(r3.code).toBe('DJ-0003');
    expect(r4.code).toBe('DJ-0004');
    const codes = store.getState().records.map((x) => x.code).filter(Boolean) as string[];
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('【编号】全部已有号码时再次生成：返回 0，不改动任何号码', async () => {
    const store = new AppStore();
    const r = await seedRiddle(store, 1);
    await store.addRecord({ riddleId: r.id, prize: '参与奖', at: 1000 });
    expect(await store.generatePrizeCodes()).toBe(1);
    const codesBefore = store.getState().records.map((x) => x.code);
    expect(await store.generatePrizeCodes()).toBe(0);
    expect(store.getState().records.map((x) => x.code)).toEqual(codesBefore);
  });

  it('【编号】号码生成结果落盘到存储层', async () => {
    const store = new AppStore();
    const r = await seedRiddle(store, 1);
    const rec = await store.addRecord({ riddleId: r.id, prize: '参与奖', at: 1000 });
    await store.generatePrizeCodes();
    const persisted = await idb.getAll<OnsiteRecord>(idb.STORE_RECORDS);
    expect(persisted.find((x) => x.id === rec.id)?.code).toBe('DJ-0001');
  });
});

describe('登记 · 实时统计（统计口径错看这里）', () => {
  it('【统计】空库空登记：total/solved/remaining/prizes 全为 0', () => {
    const store = new AppStore();
    expect(store.stats()).toEqual({ total: 0, solved: 0, remaining: 0, prizes: 0 });
  });

  it('【统计】同一谜号登记多次：solved 按谜号去重计 1，剩余数随之减少', async () => {
    const store = new AppStore();
    const [a, b, c] = await Promise.all([1, 2, 3].map((i) => seedRiddle(store, i)));
    await store.addRecord({ riddleId: a.id, prize: '一等奖', at: 1000 });
    await store.addRecord({ riddleId: a.id, prize: '参与奖', at: 2000 });
    await store.addRecord({ riddleId: b.id, prize: '二等奖', at: 3000 });
    expect(store.stats()).toEqual({ total: 3, solved: 2, remaining: 1, prizes: 3 });
    expect(c.id).toBeTruthy(); // 第三条未猜中
  });

  it('【统计】奖品名称为空白（空串/空格/制表符）不计入奖品发放数，但仍算已猜中', async () => {
    const store = new AppStore();
    const [a, b, c, d] = await Promise.all([1, 2, 3, 4].map((i) => seedRiddle(store, i)));
    await store.addRecord({ riddleId: a.id, prize: '一等奖', at: 1000 });
    await store.addRecord({ riddleId: b.id, prize: '   ', at: 2000 });
    await store.addRecord({ riddleId: c.id, prize: '', at: 3000 });
    await store.addRecord({ riddleId: d.id, prize: '\t', at: 4000 });
    const s = store.stats();
    expect(s.total).toBe(4);
    expect(s.solved).toBe(4);
    expect(s.remaining).toBe(0);
    expect(s.prizes).toBe(1); // 仅「一等奖」
  });

  it('【统计】删除登记后统计实时回落', async () => {
    const store = new AppStore();
    const a = await seedRiddle(store, 1);
    const rec = await store.addRecord({ riddleId: a.id, prize: '一等奖', at: 1000 });
    expect(store.stats().solved).toBe(1);
    await store.removeRecord(rec.id);
    expect(store.stats()).toEqual({ total: 1, solved: 0, remaining: 1, prizes: 0 });
  });
});
