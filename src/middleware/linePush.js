// LINE Messaging API push helper.
//
// Separate from /auth/line-* (which uses the LINE Login channel for
// OAuth verification) — push messages flow through the Messaging API
// channel and need its own channel access token. Configure on Render
// via:
//   LINE_OA_CHANNEL_TOKEN = <long-lived token from the Messaging API
//                            channel's "Channel access token" section>
//
// Without that env var set, push() silently no-ops so the rest of the
// app keeps working — useful during the period after we ship this code
// but before the user has created the Messaging API channel + paired
// it with their LINE OA.
const ENDPOINT = 'https://api.line.me/v2/bot/message/push';

// Push a single text message to one LINE userId. Fire-and-forget at the
// call site; we never want a flaky LINE response to fail the originating
// HTTP request (e.g. leave-approval shouldn't 500 just because LINE is
// having a moment).
async function pushTextTo(lineUserId, text, options = {}) {
  const token = process.env.LINE_OA_CHANNEL_TOKEN;
  if (!token) return { skipped: 'no-token' };
  if (!lineUserId || !text) return { skipped: 'missing-args' };
  // LINE rejects messages > 5000 chars. Trim with a marker so the
  // recipient knows it was cut.
  const body = text.length > 4900 ? `${text.slice(0, 4900)}\n…(ตัดข้อความ)` : text;
  const messages = [{ type: 'text', text: body }];
  // Optional quick-reply button to deep-link back into the LIFF app for
  // this notification. We use a uri action so tapping opens the
  // dashboard in the same LINE webview.
  if (options.link && process.env.PUBLIC_LIFF_URL) {
    messages[0].quickReply = {
      items: [{
        type: 'action',
        action: {
          type: 'uri',
          label: 'เปิดในแอป',
          uri: `${process.env.PUBLIC_LIFF_URL}${options.link.startsWith('/') ? '' : '/'}${options.link}`,
        },
      }],
    };
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: lineUserId, messages }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[line-push] ${res.status} for ${lineUserId}: ${errText.slice(0, 200)}`);
      return { ok: false, status: res.status };
    }
    return { ok: true };
  } catch (err) {
    console.error(`[line-push] network error for ${lineUserId}:`, err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { pushTextTo };
