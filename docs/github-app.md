# Connecting GitHub (GitHub App)

The `github` feature links project repos to GitHub. It acts as a **GitHub App**: you create the app
once, then you (or a friend) install it on the accounts and repos it may use. No personal tokens are
shared, and its actions show up as `<app-name>[bot]`.

## 1. Create the app (once)

1. On GitHub, open the settings of the account or organization that should own the app (for an
   organization: **Organization settings → Developer settings → GitHub Apps**; for yourself:
   **Settings → Developer settings → GitHub Apps**) and click **New GitHub App**.
2. **GitHub App name**: anything unique on GitHub, e.g. `szamanex-bot`. **Homepage URL**: the
   discord-kit repository URL.
3. **Webhook**: untick **Active**. The bot polls GitHub; it needs no incoming connections.
4. **Repository permissions**:
   - Issues: **Read and write**
   - Pull requests: **Read-only**
   - Checks: **Read-only**
   - Commit statuses: **Read-only**
   - Metadata: Read-only (set automatically)
5. **Where can this GitHub App be installed?** **Any account** lets friends install it on their own
   repos; **Only on this account** keeps it to yours.
6. **Create GitHub App**. Note the **App ID** shown at the top.
7. **Private keys → Generate a private key**. A `.pem` file downloads. Store it in your password
   manager; anyone with it can act as the app.

## 2. Install it on repos

On the app's page, **Install App** → pick the account → **Only select repositories** → choose the
repos your projects use. You can add repos later the same way. Friends install it on their repos
from the app's public page (`https://github.com/apps/<app-name>`).

## 3. Give the bot the credentials

In the bot's `.env`:

```
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY_FILE=/path/to/szamanex-bot.private-key.pem
```

or, when a file is awkward (e.g. some hosting panels), the key itself with `\n` for line breaks:

```
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n"
```

With Docker, mount the key read-only (`- ./github-app.pem:/secrets/github-app.pem:ro`) and set
`GITHUB_PRIVATE_KEY_FILE=/secrets/github-app.pem`.

## 4. Enable the feature

In the preset:

```yaml
features:
  github:
    enabled: true
    # poll_minutes: 5        # how often GitHub is checked for changes (1–60)
    # label_prefix: 'status: '
    # issues_for_posts: true # create GitHub issues for member-made forum tickets
```

Restart the bot, then link a repo to verify the GitHub App can access it. GitHub requests have a
10-second timeout per attempt.

## 5. Link repos

`/project repo add repo:owner/name` (or `repos:` of `/project create`):

- the bot checks that the app is installed on the repo (if not, it replies with the install link)
  and that no other project has the repo
- it creates the status labels (`status: Todo`, `status: In progress`, …) that are missing; it never
  edits or deletes labels
- it asks whether to **import the open issues** or take **only new issues**

## 6. How sync works

- **Import:** after a repo is added, **Import N open issues** turns every open issue into a ticket
  (one summary line in `#activity`); **Only new issues** starts from now. Either way, issues opened
  later become tickets on their own.
- **GitHub → Discord:** every `poll_minutes` (and on `/project sync`), changes to linked issues are
  applied: title, status (the `status: …` label; closing an issue moves the ticket to the first done
  status, reopening it back), and assignees of members who set their GitHub username with
  `/profile edit`. Activity lines say "changed on GitHub".
- **Discord → GitHub:** every change to a linked ticket is pushed right away: status label, closed
  when the ticket reaches a done status, title, assignees.
- **Assignees need a profile:** a member is matched to a GitHub login only through
  `/profile edit`. Anyone else is skipped, but not silently: a ticket assignee without a GitHub
  username gets a note in the ticket ("has no GitHub username yet…"), once per member and ticket;
  an issue assignee whose login matches no profile is listed in the ticket's control message as
  `github: login (not linked)`, with a hint to run `/profile edit`. Logins the bot can't match are
  never removed from the issue.
- **Who wins:** GitHub, except for changes made in Discord in the last two minutes (they may still
  be on their way). If a push fails, the bot notes it in the ticket, and the next poll brings
  GitHub's state back.
- Use `/ticket edit` to edit the Discord ticket. Title edits sync to GitHub. Description edits
  stay in Discord, and comments stay on the service where they were posted.
- **Connecting tickets:** `/ticket new` creates the issue in the project's default repo (`repo:` to
  pick another, `repo:none` for a local ticket); `/ticket link issue:owner/name#42` links an
  existing issue (its state wins); `/ticket push` creates an issue for a local ticket.
- **Forum posts:** tickets made by posting in a project’s `#tickets` forum automatically create
  issues in its default repo. The issue gets the title, starter message, and initial status label.
  Set `features.github.issues_for_posts: false` to keep these tickets local by default. When issue
  creation fails, the Discord ticket stays usable. After a timeout, check the repo for the issue
  before using `/ticket push`; GitHub may have accepted the request.
- **Deleting a ticket post:** on the next poll (or `/project sync`), the bot comments on the
  linked open issue and closes it as **not planned**. An already-closed issue keeps its existing
  close reason. Failed closes are logged and retried on later polls. Reopening the issue on GitHub
  does not automatically recreate the deleted ticket. You can link a new ticket to it.

## 7. Pull request alerts

With each poll, the bot also looks at open pull requests of linked repos and posts when:

- ❌ **CI fails** (a check run or status fails), once per commit, so re-runs don't repeat it
- ✅ **CI passes again** after a failure was posted
- ⚠️ **merge conflicts** appear
- 🔁 a reviewer **requests changes**

A pull request that refers to a linked issue (`#12`, `owner/repo#12`, `Fixes #12`) gets its alerts in
that ticket's post; others go to the project's `#activity`. Only the pull request's author is
pinged, and only if they set their GitHub username with `/profile edit`. Pull requests that are just
waiting for a review are not alerted.
