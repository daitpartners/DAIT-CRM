/**
 * Real-world-like email bodies for the HTML reader (owner, 23 Nov 2026), as the API stores them once sanitised: a
 * newsletter laid out with tables and a <style> block, and a reply whose signature is a table. Images are data: SVGs
 * so nothing is fetched from the network.
 */
const svg = (w: number, h: number, fill: string, label: string) =>
  `data:image/svg+xml;base64,${Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" rx="6" fill="${fill}"/>` +
      `<text x="50%" y="55%" font-family="Arial" font-size="${Math.round(h / 3)}" fill="#fff" text-anchor="middle">${label}</text></svg>`,
  ).toString('base64')}`;

export const NEWSLETTER_HTML = `<style>.btn{background:#0a66c2;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:4px;display:inline-block;font-weight:bold}
.muted{color:#6b6b6b;font-size:12px} h1{font-family:Georgia,serif}</style>
<div style="display:none">This week: three ideas for your Q1 website refresh</div>
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f2f1"><tr><td align="center" style="padding:24px 12px">
<table width="600" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:600px;border:1px solid #e1dfdd">
<tr><td style="padding:20px 28px;border-bottom:3px solid #0a66c2"><img src="${svg(140, 40, '#0a66c2', 'Northwind')}" alt="Northwind" width="140" height="40"></td></tr>
<tr><td style="padding:0"><img src="${svg(600, 180, '#2b88d8', 'Q1 Website Refresh')}" alt="Q1 Website Refresh" width="600" height="180" style="display:block;width:100%;height:auto"></td></tr>
<tr><td style="padding:24px 28px;font-family:Segoe UI,Arial,sans-serif;color:#323130;font-size:15px;line-height:1.5">
<h1 style="font-size:24px;margin:0 0 12px;color:#201f1e">Three ideas for your Q1 website refresh</h1>
<p style="margin:0 0 14px">Hi Arjun,</p>
<p style="margin:0 0 14px">Planning a new site for next quarter? Here is what our clients asked for most this year:</p>
<ul style="margin:0 0 16px;padding-left:22px"><li><b>Faster pages</b> — under two seconds on mobile.</li><li><b>Clear calls to action</b> on every service page.</li><li><b>Case studies</b> that show results, not only logos.</li></ul>
<p style="margin:0 0 20px"><a class="btn" href="https://northwind.example/q1-guide" target="_blank" rel="noopener noreferrer">Read the full guide</a></p>
<table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="50%" valign="top" style="padding:12px;background-color:#faf9f8;border:1px solid #edebe9"><b>Webinar</b><br><span class="muted">Thu 4 Dec · 16:00 GMT</span></td>
<td width="50%" valign="top" style="padding:12px;background-color:#faf9f8;border:1px solid #edebe9"><b>Price list 2027</b><br><span class="muted">PDF · 1.2 MB</span></td>
</tr></table></td></tr>
<tr><td class="muted" align="center" style="padding:16px 28px;border-top:1px solid #edebe9">Northwind Digital · 12 King Street, London<br><a href="https://northwind.example/unsubscribe" target="_blank" rel="noopener noreferrer" style="color:#6b6b6b">Unsubscribe</a></td></tr>
</table></td></tr></table>`;

export const NEWSLETTER_TEXT =
  'This week: three ideas for your Q1 website refresh\n\nThree ideas for your Q1 website refresh\n\nHi Arjun,\n\nPlanning a new site for next quarter?';

export const SIGNATURE_HTML = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#000000">
<p style="margin:0">Hi Arjun,</p><p style="margin:0">&nbsp;</p>
<p style="margin:0">Thanks for the proposal. Thursday at 3pm works for us — could you send an invite with a Teams link?</p>
<p style="margin:0">&nbsp;</p><p style="margin:0">Best regards,</p><p style="margin:0">&nbsp;</p>
<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>
<td valign="top" style="padding:0 12px 0 0;border-right:2px solid #c00000"><img src="${svg(64, 64, '#c00000', 'OR')}" alt="Orbit" width="64" height="64"></td>
<td valign="top" style="padding:0 0 0 12px;font-family:Calibri,Arial,sans-serif;font-size:10pt;color:#404040">
<b style="color:#c00000;font-size:11pt">Neha Rao</b><br>Head of Marketing · Orbit Logistics<br>
<font color="#7f7f7f">T</font> +44 20 7946 0012 · <font color="#7f7f7f">M</font> +44 7700 900123<br>
<a href="https://orbit.example" target="_blank" rel="noopener noreferrer" style="color:#0563c1">orbit.example</a></td></tr></table>
<p style="margin:12px 0 0">&nbsp;</p>
<div style="border:none;border-top:solid #e1e1e1 1.0pt;padding:3.0pt 0 0 0"><p style="margin:0"><b>From:</b> Arjun Mehta &lt;arjun.mehta@daitpartners.com&gt;<br><b>Sent:</b> Monday, 24 November 2026 10:12<br><b>Subject:</b> Orbit website proposal</p></div>
<blockquote style="margin:8px 0 0 0;padding-left:10px;border-left:2px solid #c8c8c8;color:#555">Hi Neha,<br><br>Please find our proposal attached. Happy to walk you through it this week.<br><br>Arjun</blockquote>
</div>`;

export const SIGNATURE_TEXT = 'Hi Arjun,\n\nThanks for the proposal. Thursday at 3pm works for us — could you send an invite with a Teams link?';

export const PLAIN_TEXT = 'Hi Arjun,\n\nQuick one: can you resend the invoice for October?\nThe PDF did not open on my phone.\n\nThanks,\nLuis';
