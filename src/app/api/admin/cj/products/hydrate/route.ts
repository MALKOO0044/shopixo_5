import { NextResponse } from 'next/server';
import { ensureAdmin } from '@/lib/auth/admin-guard';
import { ensureHydrated } from '@/lib/hydration/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const start = Date.now();
  try {
    const guard = await ensureAdmin();
    if (!guard.ok) {
      return NextResponse.json({ ok: false, error: guard.reason }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    }

    let body: any = {};
    try { body = await req.json(); } catch {}
    const pid = String(body?.pid || body?.productId || '').trim();
    if (!pid) {
      return NextResponse.json({ ok: false, error: 'pid is required' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }

    const profitMargin = body?.profitMargin != null ? Number(body.profitMargin) : undefined;
    const countryCode = typeof body?.countryCode === 'string' ? body.countryCode : undefined;
    const force = Boolean(body?.force);

    const product = await ensureHydrated(pid, { profitMargin, countryCode, dispersionThreshold: 20, force });
    const duration = Date.now() - start;
    console.log(`[Hydrate API] pid=${pid} duration=${duration}ms variants=${product.variants.length}`);

    return NextResponse.json({ ok: true, product, duration }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    const msg = e?.message || 'Hydration failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
