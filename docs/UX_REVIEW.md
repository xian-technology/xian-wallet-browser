# UX Review

Use this script when reviewing the wallet as a product, not just as a codebase.

## Review Goals

Check four things on every pass:

- users can predict what happens next
- risky actions are visually obvious before approval
- important data is visible without opening raw payloads
- the popup, approval window, and site connection flows use consistent language

## Task Script

Run the tasks in order and note where people hesitate, backtrack, or misread a
screen.

### 1. First-time setup

- Create a new wallet from the popup.
- Confirm the recovery phrase screen makes the security requirement obvious.
- Confirm the next step after setup is clear without reading long copy.

### 2. Site connection

- Open a test dapp and request accounts.
- Review the connect approval window.
- Check whether the site identity, requested chain, and approval consequence are
  immediately obvious.

### 3. Value-moving action

- Trigger a `xian_sendCall` or transaction approval against a mock/devnet RPC.
- Confirm the summary highlights contract, function, destination, amount, and
  stamp budget before the raw payload.
- Confirm the approve and reject buttons are unambiguous.

### 4. Permission management

- Open the connected apps view.
- Disconnect a site.
- Check whether it is obvious that future actions will require reconnection.

### 5. Security and network management

- Lock and unlock the wallet.
- Reveal the recovery phrase with password confirmation.
- Add, switch, and remove a custom network preset.
- Check whether the difference between ready, unreachable, and mismatch states
  is easy to understand.

## Heuristics

Use these prompts during review:

- Is the main action visually strongest on every screen?
- Is the dangerous action called out without being alarmist everywhere?
- Are the same terms used consistently for site, app, account, chain, network,
  and wallet?
- Does every approval screen answer “who is asking, what is being requested,
  and what changes if I approve?”
- Does the popup avoid duplicating the same information in multiple sections?
- Is raw payload detail available when needed but out of the critical path?

## Recommended Review Loop

- Run the automated browser suite first so UX review is not mixed with obvious
  regressions.
- Do one solo heuristic pass by the implementer.
- Do one pass with a teammate who did not build the feature.
- Prefer a clean browser profile and a seeded mock/devnet so the review is
  focused on flow clarity, not setup noise.

## What To Record

- screen where confusion happened
- exact question or hesitation from the reviewer
- whether the issue is copy, layout, terminology, or workflow
- proposed fix in one sentence
