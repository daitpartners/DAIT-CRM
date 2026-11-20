# OpenLiteSpeed setup (CyberPanel) for the CRM

Run the commands marked `!` in your own terminal. Hostnames: `crm-test.daitpartners.com` (test, port 3091) and `crm.daitpartners.com` (live, port 3090). Server: 88.222.213.73.

## 1. Cloudflare DNS

Cloudflare, `daitpartners.com`, DNS, add two A records:

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `crm-test` | 88.222.213.73 | DNS only (grey cloud) |
| A | `crm` | 88.222.213.73 | DNS only (grey cloud) |

Recommendation: grey cloud. Let's Encrypt validates straight against the server, the certificate renews on its own in CyberPanel, and there is no second TLS layer to keep in step. (Proxied with SSL mode "Full (strict)" also works once the certificates exist; switch to it later if you want Cloudflare's firewall in front.)

Check: `! dig +short crm-test.daitpartners.com crm.daitpartners.com` prints 88.222.213.73 twice.

## 2. Create the two websites in CyberPanel

CyberPanel (https://88.222.213.73:8090) → Websites → Create Website, once per hostname:

- Select Package: Default; Owner: admin; Domain name: `crm-test.daitpartners.com` (then `crm.daitpartners.com`); an email address you read; PHP: any (unused).
- Tick SSL if offered, then Create Website.
- Websites → List Websites → Manage → Issue SSL (or SSL → Issue SSL, choose the hostname). Wait for "SSL Issued".

## 3. Point each site at the Node app

CyberPanel → Websites → List Websites → Manage → vHost Conf. Add the blocks below at the end of the file (leave the existing content), then Save.

### Test site (`crm-test.daitpartners.com`), with basic auth

```
extprocessor crm-test {
  type                    proxy
  address                 http://127.0.0.1:3091
  maxConns                100
  pcKeepAliveTimeout      60
  initTimeout             60
  retryTimeout            0
  respBuffer              0
}

realm crmtest {
  userDB  {
    location              /home/crm-test.daitpartners.com/.htpasswd
  }
}

context / {
  type                    proxy
  handler                 crm-test
  addDefaultCharset       off
  realm                   crmtest
  authName                DAIT CRM test
}
```

Create the password file (CyberPanel site owner is normally the site's own user; use `ls -ld /home/crm-test.daitpartners.com` to confirm the directory):

```
! sudo htpasswd -c /home/crm-test.daitpartners.com/.htpasswd tester
! sudo chmod 640 /home/crm-test.daitpartners.com/.htpasswd
```

(`htpasswd` asks for the password; it comes from `httpd-tools`: `sudo dnf install -y httpd-tools` if missing. Add more people without `-c`.) Basic auth sits in front of the app's own sign-in, so the test data is not public.

### Live site (`crm.daitpartners.com`), no basic auth

```
extprocessor crm-live {
  type                    proxy
  address                 http://127.0.0.1:3090
  maxConns                100
  pcKeepAliveTimeout      60
  initTimeout             60
  retryTimeout            0
  respBuffer              0
}

context / {
  type                    proxy
  handler                 crm-live
  addDefaultCharset       off
}
```

## 4. Restart and check

```
! sudo /usr/local/lsws/bin/lswsctrl restart
```

(A graceful restart: CyberPanel's Server Status → Services → LiteSpeed → Restart does the same.) Browser check: `https://crm-test.daitpartners.com/api/health` asks for the basic-auth login and then shows `{"ok":true,"release":"..."}` once a release is deployed (a 503/Bad Gateway before the first deploy is expected).

Client IPs: the app trusts `X-Forwarded-For` only from 127.0.0.1, which is what OpenLiteSpeed's proxy sends, so the sign-in rate limit counts real client addresses.
