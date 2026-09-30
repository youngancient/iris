-- Seed data provided by RelayPay (artifact/assets/seed-data)

create table customers (
  customer_id     text primary key,
  company_name    text not null,
  contact_name    text,
  contact_email   text,
  plan            text check (plan in ('Starter', 'Growth', 'Scale')),
  account_status  text check (account_status in ('active', 'restricted', 'pending verification')),
  region          text,
  kyc_status      text check (kyc_status in ('pending', 'approved', 'review required')),
  support_notes   text
);

create table transactions (
  transaction_id      text primary key,
  customer_id         text references customers (customer_id),
  transaction_type    text check (transaction_type in ('incoming transfer', 'outgoing payout', 'invoice payment')),
  amount              numeric(14, 2),
  currency            text,
  destination_country text,
  status              text check (status in ('processing', 'completed', 'delayed', 'failed', 'review required')),
  created_at          date,
  estimated_arrival   date,
  support_summary     text
);

create table payouts (
  payout_id       text primary key,
  transaction_id  text references transactions (transaction_id),
  customer_id     text references customers (customer_id),
  recipient_name  text,
  amount          numeric(14, 2),
  currency        text,
  status          text check (status in ('scheduled', 'processing', 'completed', 'failed', 'review required')),
  scheduled_for   date,
  failure_reason  text
);

create index on customers (lower(contact_email));
create index on customers (lower(company_name));

-- Server-only access: RLS on with no policies (see 002 for the full note).
alter table customers    enable row level security;
alter table transactions enable row level security;
alter table payouts      enable row level security;
