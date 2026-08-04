# Feishu Local Usage

This local-first integration needs no Cloudflare Tunnel, public URL, or cloud
server. The Windows desktop runtime starts the API and Worker on this computer,
then the API makes an outbound long connection to Feishu.

## One-Time Platform Setting

In the existing Feishu app's Event Subscription page, add the app event
`im.message.receive_v1` (Receive Message). Keep the already configured card
action callback enabled. Publish the app version after saving the event change.

The existing local `.env` needs `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, and
`FEISHU_TARGET_OPEN_ID`; no new secret is introduced for text intake.

## Expected Behavior

1. Start the desktop application while the computer is on.
2. Send the configured bot a text message containing a task, idea, or question.
3. The bot returns a candidate card. Confirming it creates exactly one formal
   task or one inbox entry. Replaying the same Feishu message does not create a
   duplicate.
4. A task with incomplete timing or an exact-time conflict is not saved from
   Feishu. The bot asks the user to open the desktop application, where the
   user can complete fields or explicitly keep a conflict.

Only the configured `FEISHU_TARGET_OPEN_ID` can operate the cards or create
intake candidates. The integration neither changes an existing task nor
auto-reschedules a plan.
