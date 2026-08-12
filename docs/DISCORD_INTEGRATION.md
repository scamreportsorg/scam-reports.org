# Discord integration

Discord mirrors a few site features and carries notifications. It is never the authority for website rank or access.

The integration can:

- mirror one website activity rank as one cosmetic Discord role;
- notify a private moderation channel about new queue items;
- edit one public status message;
- edit one private security-monitor embed.

Deploying the code does not enable any of these. Each environment needs its own bot, guild, roles, webhooks, channels, secrets, migrations through `0021_magic_login_browser_context.sql`, matching Worker release, and scheduled trigger.

## Boundaries

- Only approved website activity feeds rank.
- A Discord role never grants website, repository, evidence, staff, or production access.
- Discord staff roles are not imported into the site.
- The bot may touch only the six configured cosmetic roles. It leaves every other role alone.
- OAuth links identity; it neither installs the bot nor joins the guild.
- A linked member outside the guild stays pending and may be shown the configured invite.

## Roles and bot

Create six roles with **zero permissions**:

| Website rank | Discord role             |
| ------------ | ------------------------ |
| Level 1      | `Lv1 Newcomer`           |
| Level 2      | `Lv2 Contributor`        |
| Level 3      | `Lv3 Regular`            |
| Level 4      | `Lv4 Senior Contributor` |
| Level 5      | `Lv5 Veteran`            |
| Level 6      | `Lv6 Community Guardian` |

Give the bot role exactly **Manage Roles**. Do not grant Administrator, Manage Server, Manage Channels, Manage Messages, or moderation permissions. Put it above all six cosmetic roles and below every staff role.

Sync looks up one linked member at a time. It neither enumerates the guild nor subscribes to the Gateway, so the privileged `GUILD_MEMBERS` intent stays off.

## Channels

Use three separate destinations:

- **Moderation:** `MODERATOR_DISCORD_WEBHOOK_URL`. Private messages contain only an event type, opaque case ID, and protected admin link.
- **Status:** `DISCORD_STATUS_WEBHOOK_URL`. The Worker creates one public embed and edits it every minute. It is stale after more than three minutes without an update.
- **Security:** `DISCORD_SECURITY_CHANNEL_ID`. This is a fixed private channel. Give the bot only View Channel, Send Messages, and Embed Links through channel overrides.

Webhook URLs are credentials. Restrict channel access. After exposure, rotate the webhook and update the Worker secret. The client accepts Discord's fixed webhook origin only, refuses redirects, and suppresses mentions.

The security monitor polls Cloudflare WAF every minute. It deduplicates events and groups them by normalized endpoint and a daily source fingerprint. Application responses are deliberately not logged to D1 because that would give an attacker a database-write path. Discord receives country, ASN, coarse action, count, and first and last timestamps. It never receives raw IPs, query strings, bodies, cookies, authorization values, account IDs, email addresses, or full user agents. D1 observations expire after 20 minutes and incident rollups after 72 hours.

Status contains coarse states for Website, API, Database, Sign-in, Evidence, Email, Discord roles, Backups, and Scheduled jobs, plus version and time. If the Worker or Cloudflare is fully down, it cannot edit its message. The stale timestamp is therefore the only in-band warning. Out-of-band alerts need another provider.

## Configuration

Configure environments separately. Tokens and webhook URLs are Worker secrets. IDs, invite, and feature flags are runtime configuration.

| Name                            | Use                                                                         |
| ------------------------------- | --------------------------------------------------------------------------- |
| `DISCORD_ROLE_SYNC_ENABLED`     | Exact `true` enables rank sync after validation. Keep `false` during setup. |
| `DISCORD_BOT_TOKEN`             | Bot credential for member/role API calls.                                   |
| `DISCORD_GUILD_ID`              | Target server.                                                              |
| `DISCORD_ROLE_LEVEL_1_ID`       | `Lv1 Newcomer` role ID.                                                     |
| `DISCORD_ROLE_LEVEL_2_ID`       | `Lv2 Contributor` role ID.                                                  |
| `DISCORD_ROLE_LEVEL_3_ID`       | `Lv3 Regular` role ID.                                                      |
| `DISCORD_ROLE_LEVEL_4_ID`       | `Lv4 Senior Contributor` role ID.                                           |
| `DISCORD_ROLE_LEVEL_5_ID`       | `Lv5 Veteran` role ID.                                                      |
| `DISCORD_ROLE_LEVEL_6_ID`       | `Lv6 Community Guardian` role ID.                                           |
| `DISCORD_COMMUNITY_INVITE_URL`  | `https://discord.gg/...` or `https://discord.com/invite/...`.               |
| `DISCORD_STATUS_WEBHOOK_URL`    | Public status webhook.                                                      |
| `MODERATOR_DISCORD_WEBHOOK_URL` | Private moderation webhook.                                                 |
| `SECURITY_MONITOR_ENABLED`      | Exact `true` enables the private monitor after validation.                  |
| `DISCORD_SECURITY_CHANNEL_ID`   | Fixed private monitor channel.                                              |
| `CLOUDFLARE_ZONE_ID`            | Zone queried for Security Events.                                           |
| `CLOUDFLARE_SECURITY_API_TOKEN` | Zone-restricted read-only Account Analytics token.                          |

All six role IDs must be valid and unique. Missing or duplicate IDs fail closed. Never paste tokens, webhook URLs, secret-setting output, or production IDs into chat, Git, screenshots, issues, or CI logs.

## Data and retries

Discord IDs are encrypted at rest and indexed with keyed hashes. Unlinking, deletion, and suspension queue removal of the managed role. The encrypted cleanup target exists only for that bounded job and expires after 30 days even if Discord remains down.

Rank jobs recalculate current website state when they run and replace older desired state. They obey Discord rate limits, retry within bounds, and preserve unrelated roles. Notification intent is committed with its moderation event. Repeated failure ends in a staff-visible dead-letter state, not an endless retry loop.

## Activation

1. Create six zero-permission roles in the order above.
2. Install the bot with Manage Roles only. Put it above ranks and below staff.
3. Create separate moderation, status, and security channels with the permissions above.
4. Configure the environment with `DISCORD_ROLE_SYNC_ENABLED=false` and `SECURITY_MONITOR_ENABLED=false`.
5. Apply migrations through 0021. Deploy the matching reviewed Worker with its one-minute trigger.
6. Confirm status edits the same message every minute.
7. Link a disposable staging member, join the server, request sync, and verify exactly one cosmetic role while unrelated roles remain.
8. Exercise every queue type and inspect its minimal moderation message.
9. Enable the private monitor and test with synthetic events. Verify that no raw network or account data appears.
10. Confirm unlink and suspension remove the managed role, then enable rank sync.

Never test by granting a production staff role. If the bot changes anything outside this boundary, disable sync and remove its credential. Investigate before enabling it again.
