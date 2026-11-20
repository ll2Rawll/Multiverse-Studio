/** Pure data helpers, tested in tests/metrics.test.ts. */
export interface Order {
  id: string;
  date: string; // YYYY-MM-DD
  customer: string;
  region: 'North' | 'South' | 'East' | 'West';
  status: 'paid' | 'refunded' | 'pending';
  total: number;
}

export interface Filters {
  region: Order['region'] | 'all';
  status: Order['status'] | 'all';
  query: string;
}

export function filterOrders(orders: Order[], f: Filters): Order[] {
  const q = f.query.trim().toLowerCase();
  return orders.filter((o) => (f.region === 'all' || o.region === f.region) && (f.status === 'all' || o.status === f.status) && (!q || o.customer.toLowerCase().includes(q) || o.id.toLowerCase().includes(q)));
}

export function kpis(orders: Order[]): { revenue: number; orders: number; average: number; refundRate: number } {
  const paid = orders.filter((o) => o.status === 'paid');
  const revenue = paid.reduce((s, o) => s + o.total, 0);
  const refunded = orders.filter((o) => o.status === 'refunded').length;
  return {
    revenue: Math.round(revenue * 100) / 100,
    orders: orders.length,
    average: paid.length ? Math.round((revenue / paid.length) * 100) / 100 : 0,
    refundRate: orders.length ? refunded / orders.length : 0,
  };
}

/** Paid revenue per day, in date order, with missing days filled with 0. */
export function revenueByDay(orders: Order[]): { date: string; value: number }[] {
  const byDay = new Map<string, number>();
  for (const o of orders) if (o.status === 'paid') byDay.set(o.date, (byDay.get(o.date) ?? 0) + o.total);
  const days = [...byDay.keys()].sort();
  if (days.length === 0) return [];
  const out: { date: string; value: number }[] = [];
  for (let d = new Date(`${days[0]}T00:00:00Z`); d <= new Date(`${days[days.length - 1]}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    out.push({ date: key, value: Math.round((byDay.get(key) ?? 0) * 100) / 100 });
  }
  return out;
}

export function revenueByRegion(orders: Order[]): { region: string; value: number }[] {
  const regions: Order['region'][] = ['North', 'South', 'East', 'West'];
  return regions.map((region) => ({ region, value: Math.round(orders.filter((o) => o.region === region && o.status === 'paid').reduce((s, o) => s + o.total, 0) * 100) / 100 }));
}

export const money = (n: number): string => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
