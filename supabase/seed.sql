-- Seed data: the provided RelayPay records (artifact/assets/seed-data/*.csv),
-- plus demo customers with real, reachable emails (CUS-1006, CUS-1007) for live testing.
-- Run in the Supabase SQL editor after migrations 001-003. Safe to re-run (upserts).

insert into customers (customer_id, company_name, contact_name, contact_email, plan, account_status, region, kyc_status, support_notes) values
  ('CUS-1001', 'LagosLedger', 'Amara Okafor', 'amara@lagosledger.example', 'Growth', 'active', 'Nigeria', 'approved', 'Customer has an active account and normal support access.'),
  ('CUS-1002', 'NairobiOps', 'Daniel Mwangi', 'daniel@nairobiops.example', 'Starter', 'pending verification', 'Kenya', 'pending', 'Customer needs to complete business verification before full payment access.'),
  ('CUS-1003', 'AccraStack', 'Efua Mensah', 'efua@accrastack.example', 'Scale', 'restricted', 'Ghana', 'review required', 'Account is under compliance review. Escalate account-specific questions.'),
  ('CUS-1004', 'CapeCloud', 'Amina Jacobs', 'amina@capecloud.example', 'Growth', 'active', 'South Africa', 'approved', 'Customer often uses contractor payouts.'),
  ('CUS-1005', 'KigaliWorks', 'Patrick Ndayisaba', 'patrick@kigaliworks.example', 'Starter', 'active', 'Rwanda', 'approved', 'Customer recently started multi-currency invoicing.')
on conflict (customer_id) do update set company_name = excluded.company_name, contact_name = excluded.contact_name, contact_email = excluded.contact_email, plan = excluded.plan, account_status = excluded.account_status, region = excluded.region, kyc_status = excluded.kyc_status, support_notes = excluded.support_notes;

insert into transactions (transaction_id, customer_id, transaction_type, amount, currency, destination_country, status, created_at, estimated_arrival, support_summary) values
  ('TXN-9001', 'CUS-1001', 'outgoing payout', '2400', 'USD', 'Kenya', 'processing', '2026-08-16', '2026-08-19', 'Payout is processing within the normal expected window.'),
  ('TXN-9002', 'CUS-1002', 'invoice payment', '1200', 'EUR', 'Nigeria', 'completed', '2026-08-12', '2026-08-15', 'Invoice payment completed.'),
  ('TXN-9003', 'CUS-1003', 'outgoing payout', '5300', 'GBP', 'Ghana', 'review required', '2026-08-13', null, 'Transaction requires compliance review. Escalate account-specific questions.'),
  ('TXN-9004', 'CUS-1004', 'outgoing payout', '800', 'USD', 'Rwanda', 'failed', '2026-08-14', null, 'Payout failed because beneficiary details need review.'),
  ('TXN-9005', 'CUS-1005', 'incoming transfer', '3100', 'EUR', 'Rwanda', 'delayed', '2026-08-11', '2026-08-18', 'Incoming transfer is delayed due to partner bank processing.')
on conflict (transaction_id) do update set customer_id = excluded.customer_id, transaction_type = excluded.transaction_type, amount = excluded.amount, currency = excluded.currency, destination_country = excluded.destination_country, status = excluded.status, created_at = excluded.created_at, estimated_arrival = excluded.estimated_arrival, support_summary = excluded.support_summary;

insert into payouts (payout_id, transaction_id, customer_id, recipient_name, amount, currency, status, scheduled_for, failure_reason) values
  ('PAY-7001', 'TXN-9001', 'CUS-1001', 'Bright Studio', '2400', 'USD', 'processing', '2026-08-18', null),
  ('PAY-7002', 'TXN-9003', 'CUS-1003', 'Kente Labs', '5300', 'GBP', 'review required', '2026-08-16', 'compliance review'),
  ('PAY-7003', 'TXN-9004', 'CUS-1004', 'Mwiza Design', '800', 'USD', 'failed', '2026-08-15', 'beneficiary details need review')
on conflict (payout_id) do update set transaction_id = excluded.transaction_id, customer_id = excluded.customer_id, recipient_name = excluded.recipient_name, amount = excluded.amount, currency = excluded.currency, status = excluded.status, scheduled_for = excluded.scheduled_for, failure_reason = excluded.failure_reason;

-- Demo customers with real emails, so emails to the customer (e.g. one-time codes) can be received.
-- CUS-1006: a normal payout in progress. CUS-1007: a failed invoice payment and a payout needing review.
insert into customers (customer_id, company_name, contact_name, contact_email, plan, account_status, region, kyc_status, support_notes) values
  ('CUS-1006', 'OkoyeWorks', 'Jude Okoye', 'judetochyxyz@gmail.com', 'Growth', 'active', 'Nigeria', 'approved', 'Customer has an active account and normal support access.'),
  ('CUS-1007', 'OdusileHQ', 'Tofunmi Odusile', 'tofunmiodusile@gmail.com', 'Starter', 'active', 'Nigeria', 'approved', 'Customer has an active account and normal support access.')
on conflict (customer_id) do update set company_name = excluded.company_name, contact_name = excluded.contact_name, contact_email = excluded.contact_email, plan = excluded.plan, account_status = excluded.account_status, region = excluded.region, kyc_status = excluded.kyc_status, support_notes = excluded.support_notes;
insert into transactions (transaction_id, customer_id, transaction_type, amount, currency, destination_country, status, created_at, estimated_arrival, support_summary) values
  ('TXN-9006', 'CUS-1006', 'outgoing payout', 1500, 'USD', 'Ghana', 'processing', '2026-08-17', '2026-08-20', 'Payout is processing within the normal expected window.'),
  ('TXN-9007', 'CUS-1007', 'invoice payment', 950, 'GBP', 'Nigeria', 'failed', '2026-08-15', null, 'Invoice payment failed. The payer''s bank declined the payment.'),
  ('TXN-9008', 'CUS-1007', 'outgoing payout', 2200, 'EUR', 'Kenya', 'review required', '2026-08-16', null, 'Payout requires additional review before it can be released.')
on conflict (transaction_id) do update set customer_id = excluded.customer_id, transaction_type = excluded.transaction_type, amount = excluded.amount, currency = excluded.currency, destination_country = excluded.destination_country, status = excluded.status, created_at = excluded.created_at, estimated_arrival = excluded.estimated_arrival, support_summary = excluded.support_summary;

insert into payouts (payout_id, transaction_id, customer_id, recipient_name, amount, currency, status, scheduled_for, failure_reason) values
  ('PAY-7004', 'TXN-9006', 'CUS-1006', 'Adwoa Creative', 1500, 'USD', 'processing', '2026-08-19', null),
  ('PAY-7005', 'TXN-9008', 'CUS-1007', 'Safari Dev Co', 2200, 'EUR', 'review required', '2026-08-18', 'additional review')
on conflict (payout_id) do update set transaction_id = excluded.transaction_id, customer_id = excluded.customer_id, recipient_name = excluded.recipient_name, amount = excluded.amount, currency = excluded.currency, status = excluded.status, scheduled_for = excluded.scheduled_for, failure_reason = excluded.failure_reason;
