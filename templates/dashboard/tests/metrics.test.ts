import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterOrders, kpis, revenueByDay, revenueByRegion, type Order } from '../src/metrics.ts';

const orders: Order[] = [
  { id: 'A1', date: '2026-03-01', customer: 'Acme', region: 'North', status: 'paid', total: 100 },
  { id: 'A2', date: '2026-03-03', customer: 'Birch', region: 'South', status: 'refunded', total: 40 },
  { id: 'A3', date: '2026-03-03', customer: 'Acme', region: 'North', status: 'paid', total: 50 },
  { id: 'A4', date: '2026-03-04', customer: 'Cobalt', region: 'West', status: 'pending', total: 70 },
];

test('filters combine region, status and search', () => {
  assert.deepEqual(filterOrders(orders, { region: 'North', status: 'all', query: '' }).map((o) => o.id), ['A1', 'A3']);
  assert.deepEqual(filterOrders(orders, { region: 'all', status: 'all', query: 'cob' }).map((o) => o.id), ['A4']);
  assert.deepEqual(filterOrders(orders, { region: 'East', status: 'all', query: '' }), []);
});

test('KPIs count paid revenue only and report the refund rate', () => {
  assert.deepEqual(kpis(orders), { revenue: 150, orders: 4, average: 75, refundRate: 0.25 });
  assert.deepEqual(kpis([]), { revenue: 0, orders: 0, average: 0, refundRate: 0 });
});

test('daily revenue fills gaps; regional revenue covers every region', () => {
  assert.deepEqual(revenueByDay(orders), [
    { date: '2026-03-01', value: 100 },
    { date: '2026-03-02', value: 0 },
    { date: '2026-03-03', value: 50 },
  ]);
  assert.deepEqual(revenueByRegion(orders).map((r) => r.value), [150, 0, 0, 0]);
});
