// 谜库与登记的状态流转测试（store.ts + idb.ts）
// 覆盖：谜号分配、保存重算校验、批量导入编号、删除/清空与活动清单同步、
//       登记写入/删除、兑奖号码生成、实时统计、无 IndexedDB 时的内存降级路径。
// 断言信息按失败原因分类：编号算错 / 重算漏了 / 存储没写进去 / 清单没同步 / 统计算错。
import { describe, it, expect, beforeEach } from 'vitest';
import { AppStore } from '../src/lib/store';
import * as idb from '../src/lib/idb';
import type { OnsiteRecord, Riddle } from '../src/types';

type RiddlePatch = Parameters<AppStore['saveRiddle']>[0];
type RecordPatch = Parameters<AppStore['addRecord']>[0];

function mk(surface: string, extra: Partial<RiddlePatch> = {}): RiddlePatch {
  return { surface, answer: '告', category: 'char', format: 'none', tags: [], difficulty: 2, ...extra };
}

let s: AppStore;

beforeEach(async () => {
  // idb 在内存降级模式下用模块级 Map 持久化，用例间必须清库保证隔离
  await Promise.all([
    idb.clearStore(idb.STORE_RIDDLES),
    idb.clearStore(idb.STORE_RECORDS),
    idb.clearStore(idb.STORE_KV),
  ]);
  s = new AppStore();
});

describe('谜库：谜号分配', () => {
  it('空库时第一条谜号为 1', async () => {
    expect(s.nextNo(), '编号算错：空库 nextNo 应为 1').toBe(1);
    const r = await s.saveRiddle(mk('一口咬掉牛尾巴'));
    expect(r.no, '编号算错：空库第一条谜号应为 1').toBe(1);
  });

  it('连续新增谜号递增', async () => {
    await s.saveRiddle(mk('谜一'));
    await s.saveRiddle(mk('谜二'));
    const r3 = await s.saveRiddle(mk('谜三'));
    expect(r3.no, '编号算错：第三条应为 3').toBe(3);
    expect(s.getState().riddles.map((r) => r.no)).toEqual([1, 2, 3]);
  });

  it('删除中间几条后再新增：取现存最大号 +1，不复用已删号', async () => {
    const r1 = await s.saveRiddle(mk('谜一'));
    const r2 = await s.saveRiddle(mk('谜二'));
    const r3 = await s.saveRiddle(mk('谜三'));
    const r4 = await s.saveRiddle(mk('谜四'));
    await s.removeRiddles([r2.id, r3.id]); // 删掉中间的 2、3 号
    expect(s.getState().riddles.map((r) => r.no)).toEqual([1, 4]);
    const r5 = await s.saveRiddle(mk('谜五'));
    expect(r5.no, '编号算错：删中间后新增应为 max(1,4)+1=5，不复用 2/3').toBe(5);
    expect(s.getState().riddles.map((r) => r.id)).toEqual([r1.id, r4.id, r5.id]);
  });

  it('同一条反复保存：谜号不变，且不复制出新条', async () => {
    const r = await s.saveRiddle(mk('原谜面'));
    await s.saveRiddle(mk('改一次', { id: r.id }));
    const r3 = await s.saveRiddle(mk('改两次', { id: r.id }));
    expect(r3.no, '编号算错：同一条反复保存谜号应保持不变').toBe(r.no);
    expect(s.getState().riddles, '反复保存不应在内存中复制新条').toHaveLength(1);
    const stored = await idb.getAll<Riddle>(idb.STORE_RIDDLES);
    expect(stored, '存储没写进去：反复保存后存储层仍应只有一条').toHaveLength(1);
    expect(stored[0].no, '编号算错：存储层谜号也应不变').toBe(r.no);
  });

  it('清空后再导入：谜号从 1 重新开始', async () => {
    await s.addRiddles([mk('旧一'), mk('旧二'), mk('旧三')]);
    await s.clearRiddles();
    expect(s.nextNo(), '编号算错：清空后 nextNo 应回到 1').toBe(1);
    await s.addRiddles([mk('新一'), mk('新二')]);
    expect(
      s.getState().riddles.map((r) => r.no),
      '编号算错：清空后再导入应从 1 重新编号',
    ).toEqual([1, 2]);
  });
});

describe('谜库：批量导入编号', () => {
  it('自带谜号与自动编号混用：自带的保留，自动的从当前最大 +1 顺序补', async () => {
    await s.addRiddles([mk('一'), mk('二'), mk('三')]); // 已有 1..3
    const n = await s.addRiddles([mk('自带', { no: 10 }), mk('自动甲'), mk('自动乙')]);
    expect(n).toBe(3);
    const bySurface = Object.fromEntries(s.getState().riddles.map((r) => [r.surface, r.no]));
    expect(bySurface['自带'], '编号算错：自带谜号应原样保留').toBe(10);
    expect(bySurface['自动甲'], '编号算错：自动编号应接在现存最大号之后').toBe(4);
    expect(bySurface['自动乙'], '编号算错：自动编号应顺序递增').toBe(5);
    // 再导入一批：自动编号应接在全新最大号（10）之后
    await s.addRiddles([mk('自动丙')]);
    expect(s.riddleByNo(11)?.surface, '编号算错：下一自动编号应为 max+1=11').toBe('自动丙');
  });

  it('同批自带谜号与自动编号不撞号（自动编号避开自带号）', async () => {
    // 空库 nextNo=1：自动序列 1,2,... 会撞上同批自带的 2 号
    await s.addRiddles([mk('自动甲'), mk('自动乙'), mk('自带', { no: 2 })]);
    const nos = s.getState().riddles.map((r) => r.no);
    expect(new Set(nos).size, '编号算错：同批导入谜号不得重复').toBe(nos.length);
    expect(s.riddleByNo(2)?.surface, '编号算错：自带谜号应原样保留').toBe('自带');
  });

  it('批量导入空数组：返回 0 且不写库', async () => {
    expect(await s.addRiddles([])).toBe(0);
    expect(s.getState().riddles).toHaveLength(0);
    expect(await idb.getAll(idb.STORE_RIDDLES), '空导入不应写入存储层').toHaveLength(0);
  });
});

describe('谜库：保存时重算校验', () => {
  it('保存即算校验（卷帘格两字 → 不通过）', async () => {
    const r = await s.saveRiddle(mk('卷帘两字', { answer: '上海', category: 'other', format: 'juanlian' }));
    expect(r.check.verdict, '重算漏了：保存时应自动计算校验结果').toBe('fail');
    expect(r.check.checkedAt).toBeGreaterThan(0);
  });

  it('修改后再保存：校验重算、checkedAt 刷新、谜号不变', async () => {
    const r1 = await s.saveRiddle(mk('卷帘', { answer: '上海', category: 'other', format: 'juanlian' }));
    expect(r1.check.verdict).toBe('fail');
    const r2 = await s.saveRiddle(mk('卷帘', { id: r1.id, answer: '山河水', category: 'other', format: 'juanlian' }));
    expect(r2.check.verdict, '重算漏了：再保存应按新谜底重算校验').toBe('suspect');
    expect(r2.check.checkedAt, '重算漏了：checkedAt 应刷新').toBeGreaterThanOrEqual(r1.check.checkedAt);
    expect(r2.no, '编号算错：重算不应改动谜号').toBe(r1.no);
  });

  it('recheckAll：全量重算并写回存储层', async () => {
    await s.addRiddles([mk('卷帘两字', { answer: '上海', category: 'other', format: 'juanlian' })]);
    // 篡改内存中的校验结果，模拟过期/脏数据
    s.getState().riddles[0].check = { verdict: 'pass', reasons: [], checkedAt: 0 };
    await s.recheckAll();
    const after = s.getState().riddles[0];
    expect(after.check.verdict, '重算漏了：recheckAll 应重算校验结果').toBe('fail');
    expect(after.check.checkedAt, '重算漏了：recheckAll 应刷新 checkedAt').toBeGreaterThan(0);
    const stored = await idb.getAll<Riddle>(idb.STORE_RIDDLES);
    expect(stored[0].check.verdict, '存储没写进去：重算结果应写回存储层').toBe('fail');
  });
});

describe('谜库：删除/清空与活动清单同步', () => {
  it('删除谜条后活动清单对应编号同步去掉（含持久化）', async () => {
    const a = await s.saveRiddle(mk('甲'));
    const b = await s.saveRiddle(mk('乙'));
    const c = await s.saveRiddle(mk('丙'));
    await s.saveSettings({ event: { ...s.getState().settings.event, riddleIds: [a.id, b.id, c.id] } });
    await s.removeRiddles([b.id]);
    expect(
      s.getState().settings.event.riddleIds,
      '清单没同步：删除谜条应同步去掉活动清单中的编号',
    ).toEqual([a.id, c.id]);
    // 持久化验证：新实例 init 后清单仍是同步后的
    const s2 = new AppStore();
    await s2.init();
    expect(s2.getState().settings.event.riddleIds, '存储没写进去：清单同步结果应持久化').toEqual([a.id, c.id]);
    expect(s2.getState().riddles.map((r) => r.id)).toEqual([a.id, c.id]);
  });

  it('清空谜库后活动清单一并清空', async () => {
    const a = await s.saveRiddle(mk('甲'));
    await s.saveSettings({ event: { ...s.getState().settings.event, riddleIds: [a.id] } });
    await s.clearRiddles();
    expect(s.getState().riddles).toHaveLength(0);
    expect(s.getState().settings.event.riddleIds, '清单没同步：清空谜库应清空活动清单').toEqual([]);
    expect(await idb.getAll(idb.STORE_RIDDLES), '存储没写进去：清空应同步到存储层').toHaveLength(0);
  });
});

describe('登记：写入、删除与重复登记', () => {
  it('登记写入：内存与存储层都能读到', async () => {
    const rec = await s.addRecord({ riddleId: 'r1', winnerName: '张三', prize: '参与奖' });
    expect(rec.id).toBeTruthy();
    expect(rec.at).toBeGreaterThan(0);
    expect(s.recordsOf('r1')).toHaveLength(1);
    const stored = await idb.getAll<OnsiteRecord>(idb.STORE_RECORDS);
    expect(stored, '存储没写进去：登记应写入存储层').toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: rec.id, riddleId: 'r1', winnerName: '张三', prize: '参与奖' });
  });

  it('删除登记：内存与存储层同步删除', async () => {
    const rec = await s.addRecord({ riddleId: 'r1', prize: '参与奖' });
    await s.removeRecord(rec.id);
    expect(s.getState().records).toHaveLength(0);
    expect(await idb.getAll(idb.STORE_RECORDS), '存储没写进去：删除应同步到存储层').toHaveLength(0);
  });

  it('同一谜号登记两次：存储层各存一条（按 id 不覆盖），统计按谜号去重', async () => {
    const r = await s.saveRiddle(mk('一口咬掉牛尾巴'));
    await s.addRecord({ riddleId: r.id, prize: '参与奖', at: 1000 });
    await s.addRecord({ riddleId: r.id, prize: '三等奖', at: 2000 }); // 存储层不去重，UI 层负责拦截
    expect(s.getState().records).toHaveLength(2);
    const stored = await idb.getAll<OnsiteRecord>(idb.STORE_RECORDS);
    expect(stored, '存储没写进去：同一谜号两次登记应各存一条').toHaveLength(2);
    expect(new Set(stored.map((x) => x.id)).size, '两条登记应有各自独立的 id').toBe(2);
    const st = s.stats();
    expect(st.solved, '统计算错：已猜中按谜号去重应为 1').toBe(1);
    expect(st.remaining, '统计算错：剩余应为 total-solved=0').toBe(0);
  });
});

describe('登记：兑奖号码生成', () => {
  it('按登记时间升序生成 DJ-0001 起（与写入顺序无关）', async () => {
    await s.addRecord({ riddleId: 'r3', prize: '', at: 3000 });
    await s.addRecord({ riddleId: 'r1', prize: '', at: 1000 });
    await s.addRecord({ riddleId: 'r2', prize: '', at: 2000 });
    expect(await s.generatePrizeCodes()).toBe(3);
    const byAt = [...s.getState().records].sort((a, b) => a.at - b.at);
    expect(byAt.map((r) => [r.riddleId, r.code])).toEqual([
      ['r1', 'DJ-0001'],
      ['r2', 'DJ-0002'],
      ['r3', 'DJ-0003'],
    ]);
  });

  it('生成两次：第二次只补没号码的，已有号码不变且不重复', async () => {
    await s.addRecord({ riddleId: 'r1', prize: '', at: 1000 });
    await s.addRecord({ riddleId: 'r2', prize: '', at: 2000 });
    expect(await s.generatePrizeCodes()).toBe(2);
    await s.addRecord({ riddleId: 'r3', prize: '', at: 3000 });
    expect(await s.generatePrizeCodes(), '第二次生成应只补没号码的那 1 条').toBe(1);
    const byAt = [...s.getState().records].sort((a, b) => a.at - b.at);
    expect(
      byAt.map((r) => r.code),
      '编号算错：已有号码不应被改写，新号码应接着排（DJ-0003）',
    ).toEqual(['DJ-0001', 'DJ-0002', 'DJ-0003']);
    expect(new Set(byAt.map((r) => r.code)).size, '编号算错：兑奖号码不得重复').toBe(3);
  });

  it('已有手工号码时：跳过不改，新号码从最大号续排', async () => {
    await s.addRecord({ riddleId: 'r1', prize: '', at: 1000, code: 'DJ-0007' });
    await s.addRecord({ riddleId: 'r2', prize: '', at: 2000 });
    expect(await s.generatePrizeCodes()).toBe(1);
    const recs = s.getState().records;
    expect(recs.find((r) => r.riddleId === 'r1')?.code, '已有号码不应被改写').toBe('DJ-0007');
    expect(recs.find((r) => r.riddleId === 'r2')?.code, '编号算错：应从已有最大号续排').toBe('DJ-0008');
  });

  it('全部已有号码时返回 0；生成的号码写入存储层', async () => {
    await s.addRecord({ riddleId: 'r1', prize: '', at: 1000 });
    await s.generatePrizeCodes();
    expect(await s.generatePrizeCodes(), '没有待补号码时应返回 0').toBe(0);
    const stored = await idb.getAll<OnsiteRecord>(idb.STORE_RECORDS);
    expect(stored[0].code, '存储没写进去：兑奖号码应写回存储层').toBe('DJ-0001');
  });
});

describe('统计：实时统计', () => {
  it('奖品名称为空白（空串/纯空格）不计入已发奖品', async () => {
    const a = await s.saveRiddle(mk('甲'));
    const b = await s.saveRiddle(mk('乙'));
    await s.addRecord({ riddleId: a.id, prize: '参与奖' });
    await s.addRecord({ riddleId: a.id, prize: '' });     // 空串不计
    await s.addRecord({ riddleId: b.id, prize: '   ' });  // 纯空格不计
    const st = s.stats();
    expect(st.total).toBe(2);
    expect(st.solved, '统计算错：两条记录两个谜号 → 已猜中 2').toBe(2);
    expect(st.remaining).toBe(0);
    expect(st.prizes, '统计算错：空白奖品名称不应计入已发奖品').toBe(1);
  });

  it('非法数据（缺 prize 字段的历史记录）不导致统计崩溃', async () => {
    const broken = { riddleId: 'ghost', at: 1000 } as unknown as RecordPatch;
    await s.addRecord(broken);
    expect(() => s.stats(), '统计算错：缺字段记录不应让统计崩溃').not.toThrow();
    expect(s.stats().prizes, '统计算错：缺 prize 字段应视为未发奖').toBe(0);
  });
});

describe('存储：内存降级路径（无 IndexedDB）', () => {
  it('环境确认：当前无 IndexedDB，idb 走内存实现（若换环境此用例需调整）', () => {
    expect(typeof indexedDB).toBe('undefined');
  });

  it('谜条写入后可从存储层原样读回（字段级往返一致）', async () => {
    const r = await s.saveRiddle(mk('一口咬掉牛尾巴', { tags: ['经典'], difficulty: 1 }));
    const all = await idb.getAll<Riddle>(idb.STORE_RIDDLES);
    expect(all, '存储没写进去：谜条应写入存储层').toHaveLength(1);
    expect(all[0]).toMatchObject({ id: r.id, no: r.no, surface: '一口咬掉牛尾巴', tags: ['经典'], difficulty: 1 });
    expect(all[0].check.verdict, '存储没写进去：校验结果应随谜条一起落库').toBe(r.check.verdict);
  });

  it('新实例 init 后完整恢复：谜库/登记/活动清单往返一致', async () => {
    const r = await s.saveRiddle(mk('一口咬掉牛尾巴'));
    await s.addRecord({ riddleId: r.id, winnerName: '张三', prize: '参与奖' });
    await s.saveSettings({ event: { ...s.getState().settings.event, riddleIds: [r.id] } });

    const s2 = new AppStore(); // 模拟重新打开应用：从存储层恢复
    await s2.init();
    const st = s2.getState();
    expect(st.ready).toBe(true);
    expect(st.riddles, '存储没写进去：恢复后谜库应有一条').toHaveLength(1);
    expect(st.riddles[0]).toMatchObject({ id: r.id, no: r.no, surface: '一口咬掉牛尾巴' });
    expect(st.riddles[0].check.verdict).toBe(r.check.verdict);
    expect(st.records, '存储没写进去：恢复后登记应有一条').toHaveLength(1);
    expect(st.records[0]).toMatchObject({ riddleId: r.id, winnerName: '张三', prize: '参与奖' });
    expect(st.settings.event.riddleIds, '存储没写进去：恢复后活动清单应保留').toEqual([r.id]);
  });
});
