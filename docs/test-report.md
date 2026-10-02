# Test evidence

## Knowledge-grounded answer

**Expected result**

A general product or policy question is answered using approved knowledge.

**Actual result**

"Does RelayPay charge for international payments?": the knowledge base was searched before the agent answered, and matched the fees and international payments sections. Iris explained that fees depend on the transaction type, corridor and payment method and are shown before a transaction is confirmed, without inventing a figure. Questions about guarantees were answered from the "Can RelayPay guarantee payment timelines?" section. Every search is recorded in retrieval_logs with its query, the sections it matched and how well they matched.

**Passed?**

Yes

**Notes or fix made**

On the first local calls the knowledge-base search sometimes timed out and fell back to a keyword search. The timeout was raised, and on the deployed build searches finish well within it.

---

## Clarifying question

**Expected result**

A vague payment or payout issue triggers a clarifying question before the agent gives an answer.

**Actual result**

"My payments… so what do I do?": Iris asked whether it was an incoming transfer, an outgoing payout or an invoice payment, and for the reference, without looking anything up or guessing a status. The turn is recorded as a clarification.

**Passed?**

Yes

**Notes or fix made**

On the first call, "Hi. I'm Jade." was treated as noise and Iris asked the caller to repeat themselves. Vapi sends punctuated transcripts, and the noise check didn't expect punctuation. It now ignores it.

When the agent left out its reply label, answers ending in "anything else?" were counted as clarifications. A reply after a successful lookup now counts as an answer.

---

## Customer lookup

**Expected result**

An account-specific request uses the MCP customer lookup tool when enough safe information is provided.

**Actual result**

The safe information is the customer's sign-in on the call page, not anything said on the call. Signed in, "I want to check my account" used the customer lookup tool, and Iris gave a short summary (active, verification approved, Growth plan) without reading out internal notes. A signed-in caller who claimed to be a different company was told the account didn't match the one they're signed in as. A caller who isn't signed in is asked to sign in first.

**Passed?**

Yes

**Notes or fix made**

Identity comes only from signing in: the sign-in travels inside a signed token when the call starts, and nothing a caller says (a company name, an email) unlocks account details. This replaced an earlier email one-time-code design.

Iris was only told the customer's ID, so "Do you know who I am?" got a vague answer. She's now told the company name as well.

---

## Transaction or payout lookup

**Expected result**

A transaction-specific request uses the relevant MCP lookup tool and avoids guessing.

**Actual result**

Signed in, a transaction lookup gave its status (processing) and estimated arrival date, and a payout lookup gave its status and scheduled date. References belonging to other customers came back as not found, without revealing they exist. Misheard references ("c x n 9 0 0 1") were read back for confirmation before any lookup. Asked to guarantee the arrival date, Iris refused.

**Passed?**

Yes

**Notes or fix made**

A caller who wasn't signed in could get the status of any reference they guessed, which could reveal that someone's payout was held for review. As a fix, lookups now only return records to their signed-in owner. Retested signed out: Iris made no lookup, revealed nothing, and offered a ticket or a specialist until the caller signs in.

When a lookup found nothing, Iris sometimes logged a ticket unasked, even though most misses were misheard references. She now asks the caller to check the reference and offers a ticket instead.

---

## Ticket creation

**Expected result**

A support issue creates a ticket through the MCP server and stores it in Supabase.

**Actual result**

4 tickets were created across the test calls, each with a category, priority, summary, status and a link to the call, plus the transaction where one was found. In one call, Iris offered a ticket for a stuck payout, the caller said "Yes, please log", and she read the ticket number back. Each ticket was posted to the team's Discord channel and emailed to the support team.

**Passed?**

Yes

**Notes or fix made**

Tickets were only stored, so the support team wasn't told about new ones. Each new ticket is now posted to Discord and emailed to the team, with delivery tracked so an outage means a retry, never a lost or duplicate message.

Iris once logged a ticket without asking, and the caller asked why. She now logs one straight away only when the caller asks for help or a rule requires it, and offers first otherwise.

---

## Human escalation

**Expected result**

A compliance, dispute, account restriction, refund, cancellation, or frustrated-customer case creates an escalation record.

**Actual result**

A frustrated caller ("you're getting me angry") got an apology and an offer of a specialist. Iris asked for a name, then an email (read back to confirm), then a callback time, one at a time, and created an escalation linked to the caller's ticket. A payout under compliance review was escalated the same way. Both escalations were posted to Discord and emailed to the support team.

**Passed?**

Yes

**Notes or fix made**

If a log entry failed to save after the escalation itself was saved, the whole tool reported failure, and Iris would have told the caller it wasn't saved. As a fix, that log entry is now saved separately and no longer affects the result.

---

## Unsupported question

**Expected result**

If the knowledge base does not support the answer, the agent says it cannot confidently answer or escalates.

**Actual result**

"Can RelayPay guarantee my payout arrives by 9 AM tomorrow?" got a clear no. Off-topic requests (play a video, sing, "tell me about your favourite thing to do") were politely declined and steered back to RelayPay. "Search the internet for other people's transactions" got an explanation of what Iris can and can't do instead.

**Passed?**

Yes

**Notes or fix made**

Initially, greetings and goodbyes ("Thank you, I'm done") were flagged as answers without approved knowledge and posted false alerts. They're now treated as small talk, and follow-ups about something already looked up in the call aren't flagged either.

---

## Voice flow

**Expected result**

The customer can ask a question by voice and receive a spoken response.

**Actual result**

9 full voice calls through Vapi on the web page, from about a minute to over 6 minutes, with a live transcript on screen. On the deployed build, Iris usually started speaking 2 to 4 seconds after the caller finished. Each call's cost, length and summary come from Vapi's end-of-call report. Stopping Iris from the dashboard during a call ends it with a short message, and the call page then shows her as unavailable.

**Passed?**

Yes

**Notes or fix made**

If the caller kept talking before Iris answered, she replied "One moment, I'm still working on that" and the real answer was lost. As a fix, the newer request now takes the turn over i.e no answer is lost.

Some first calls never connected. The browser was downloading a large noise-cancellation file while joining, which took longer than Vapi waits for the caller's audio. The call page now downloads it in the background when it opens, retries a failed connection once, and checks the microphone before starting.

Run locally, first replies took 4 to 11 seconds. Deploying the agent near the database brought that down to the times above.

---

## Logging

**Expected result**

Supabase contains conversation, retrieval, MCP tool-call, ticket, escalation, and evaluation records that match the test run.

**Actual result**

Every test call has a conversation record (start and end, final status, who was signed in, cost, length and summary), its turns (what was said, what kind of reply it was, timings and model cost), its knowledge-base searches, its MCP tool calls (tool, purpose, masked input and result, status, timestamp), and the tickets, escalations and events it created. A call's records can be followed together on the admin dashboard.

**Passed?**

Yes

**Notes or fix made**

When a caller kept talking, the abandoned attempt still logged its own events, so one reply could show several contradictory ones. As a fix, abandoned attempts now stop and log nothing, so only the reply the caller heard is logged.

Calls that failed before reaching the agent were logged with the time Vapi's report arrived instead of when they started. They now use Vapi's own start time.

Call summaries were empty, because Vapi only writes one when asked to; it's now asked to. And if the database itself failed, the failure couldn't reach the team's errors channel, since that channel is fed from the database. Those failures are now sent to the channel directly.

---
