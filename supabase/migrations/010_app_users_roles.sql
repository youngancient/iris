-- Explicit roles: every login is either staff (the admin dashboard) or a customer (the
-- call page, signed in as one RelayPay customer). One role per login, never both.
-- Linked by the Supabase Auth user ID, so an email change keeps the account and its role.

create table app_users (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        text not null check (role in ('staff', 'customer')),
  customer_id text references customers (customer_id),
  created_at  timestamptz not null default now(),
  -- A customer login belongs to exactly one customer; a staff login to none.
  check ((role = 'customer') = (customer_id is not null))
);

-- One login per customer account.
create unique index app_users_one_login_per_customer on app_users (customer_id) where customer_id is not null;

-- Server-only, like every other table: only the service role reads or writes roles,
-- so nobody can grant themselves a role from the browser.
alter table app_users enable row level security;
