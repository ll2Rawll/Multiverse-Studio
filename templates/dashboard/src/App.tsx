import { useEffect, useMemo, useState } from 'react';
import { filterOrders, kpis, money, revenueByDay, revenueByRegion, type Filters, type Order } from './metrics.ts';
import { BarChart, LineChart } from './components/Charts.tsx';

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; orders: Order[]; demo: boolean };

async function loadOrders(): Promise<{ orders: Order[]; demo: boolean }> {
  const res = await fetch('/demo-data.json');
  if (!res.ok) throw new Error(`The data request failed (${res.status}).`);
  const json = (await res.json()) as { orders: Order[]; demo?: boolean };
  return { orders: json.orders, demo: Boolean(json.demo) };
}

export function App() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [filters, setFilters] = useState<Filters>({ region: 'all', status: 'all', query: '' });
  const fetchData = () => {
    setLoad({ state: 'loading' });
    loadOrders().then(
      (r) => setLoad({ state: 'ready', ...r }),
      (e: Error) => setLoad({ state: 'error', message: e.message }),
    );
  };
  useEffect(fetchData, []);
  const orders = load.state === 'ready' ? load.orders : [];
  const visible = useMemo(() => filterOrders(orders, filters), [orders, filters]);
  const k = kpis(visible);

  return (
    <div className="app">
      <header className="top">
        <h1>Orders</h1>
        {load.state === 'ready' && load.demo && <span className="badge">Demo data</span>}
      </header>
      {load.state === 'loading' && <p className="state" role="status">Loading orders…</p>}
      {load.state === 'error' && (
        <div className="state error" role="alert">
          <p>{load.message}</p>
          <button onClick={fetchData}>Try again</button>
        </div>
      )}
      {load.state === 'ready' && (
        <>
          <form className="filters" onSubmit={(e) => e.preventDefault()} aria-label="Filters">
            <label>
              Region
              <select value={filters.region} onChange={(e) => setFilters({ ...filters, region: e.target.value as Filters['region'] })}>
                <option value="all">All regions</option>
                {['North', 'South', 'East', 'West'].map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            </label>
            <label>
              Status
              <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters['status'] })}>
                <option value="all">All statuses</option>
                <option value="paid">Paid</option>
                <option value="pending">Pending</option>
                <option value="refunded">Refunded</option>
              </select>
            </label>
            <label>
              Search
              <input type="search" placeholder="Customer or order id" value={filters.query} onChange={(e) => setFilters({ ...filters, query: e.target.value })} />
            </label>
          </form>
          <section className="kpis" aria-label="Key figures">
            <div className="kpi"><span>Revenue</span><strong>{money(k.revenue)}</strong></div>
            <div className="kpi"><span>Orders</span><strong>{k.orders}</strong></div>
            <div className="kpi"><span>Average paid order</span><strong>{money(k.average)}</strong></div>
            <div className="kpi"><span>Refund rate</span><strong>{(k.refundRate * 100).toFixed(1)}%</strong></div>
          </section>
          {visible.length === 0 ? (
            <div className="state">
              <p>No orders match these filters.</p>
              <button onClick={() => setFilters({ region: 'all', status: 'all', query: '' })}>Clear filters</button>
            </div>
          ) : (
            <>
              <section className="charts">
                <LineChart points={revenueByDay(visible)} label="Paid revenue per day" />
                <BarChart bars={revenueByRegion(visible)} label="Paid revenue by region" />
              </section>
              <table className="orders">
                <caption>{visible.length} orders</caption>
                <thead>
                  <tr><th scope="col">Order</th><th scope="col">Date</th><th scope="col">Customer</th><th scope="col">Region</th><th scope="col">Status</th><th scope="col" className="num">Total</th></tr>
                </thead>
                <tbody>
                  {visible.slice(0, 50).map((o) => (
                    <tr key={o.id}><td>{o.id}</td><td>{o.date}</td><td>{o.customer}</td><td>{o.region}</td><td><span className={`status ${o.status}`}>{o.status}</span></td><td className="num">{money(o.total)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  );
}
