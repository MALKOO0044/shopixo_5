-- Dynamic variant options: generic dimensions and signatures
-- Generated on 2026-03-25

alter table if exists public.products
  add column if not exists available_options jsonb;

alter table if exists public.product_queue
  add column if not exists available_options jsonb;

alter table if exists public.product_variants
  add column if not exists variant_options jsonb,
  add column if not exists option_signature text;

create index if not exists idx_product_variants_option_signature
  on public.product_variants(option_signature);

create index if not exists idx_product_variants_variant_options_gin
  on public.product_variants using gin (variant_options);

comment on column public.products.available_options is 'Dynamic option dimensions and values for this product. Includes values and inStockValues.';
comment on column public.product_queue.available_options is 'Dynamic option dimensions extracted before import. Includes values and inStockValues.';
comment on column public.product_variants.variant_options is 'Per-variant option map, e.g. {"Color":"Black","Format":"A4"}';
comment on column public.product_variants.option_signature is 'Deterministic normalized signature built from variant_options for stable matching.';

create table if not exists public.cj_category_option_catalog (
  id bigserial primary key,
  cj_category_id text not null,
  cj_category_name text,
  option_name text not null,
  example_values jsonb,
  in_stock_example_values jsonb,
  frequency integer not null default 0,
  sample_pid text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_cj_category_option_catalog
  on public.cj_category_option_catalog(cj_category_id, option_name);

create index if not exists idx_cj_category_option_catalog_category
  on public.cj_category_option_catalog(cj_category_id);

create index if not exists idx_cj_category_option_catalog_option
  on public.cj_category_option_catalog(option_name);
