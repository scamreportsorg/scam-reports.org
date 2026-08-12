# Report reputation

Report reputation is a sorting and discovery score built from moderated status and approved reviews. It is not a legal finding, identity check, or safety guarantee.

Member activity rank is separate. Posting more cannot change a reported profile's score or grant staff access.

## Score

Every report starts at 50. Status moves that baseline:

| Status       | Change |
| ------------ | -----: |
| Confirmed    |    -35 |
| Under Review |    -15 |
| Reported     |     -8 |
| Rejected     |    +15 |

Approved reviews use ratings from 1 to 5. Three neutral prior ratings stop one extreme review from controlling the result:

```text
weighted_average = (sum(approved_ratings) + 3 * 3) / (approved_count + 3)
review_adjustment = (weighted_average - 3) * 12.5
score = round(clamp(50 + status_adjustment + review_adjustment, 0, 100))
```

| Score  | Label              |
| ------ | ------------------ |
| 0–19   | Critical risk      |
| 20–39  | Poor               |
| 40–59  | Mixed / unverified |
| 60–79  | Good               |
| 80–100 | Trusted            |

## Confidence

Confidence says how much moderated input exists, not whether the result is correct. It gets up to four points from approved reviews, three from published evidence, and two from a final status (`Confirmed` or `Rejected`).

`Low` is 0–3, `Medium` is 4–6, and `High` is 7 or more.

## Review behavior

- Only an approved revision counts.
- Each account has one effective review per report.
- An edit creates a pending revision; the old approved revision remains effective until replacement approval.
- Email and Discord accounts have equal weight.
- Verification labels come from account state, not reviewer choice.
- Rejected, deleted, duplicate, and moderation-only reviews do not count.

A duplicate redirects to its canonical report family and creates no second ranking entry. Undoing the merge restores its independent calculation. Status and approved-revision changes recalculate deterministically and remain in history.

A review needs an account and passes Turnstile, rate limits, and moderation. Staff check coordinated voting, self-review, purchased reviews, duplicate identities, threats, and unrelated text. A low score alone is never grounds to publish an allegation.

A formula change needs a public proposal, fixture-based before-and-after results, boundary and rounding tests, and a release note.
