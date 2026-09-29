# -*- coding: utf-8 -*-
"""
一条命令把采集函数部署到腾讯云 SCF（含开函数 URL）。

只依赖标准库，手写 TC3 签名，不用装 SDK。

用法：
    export TENCENTCLOUD_SECRET_ID=AKIDxxxx
    export TENCENTCLOUD_SECRET_KEY=xxxx
    python3 cloud/deploy_tc.py \
        --region ap-shanghai \
        --token "$(openssl rand -hex 24)"

    python3 cloud/deploy_tc.py --zip cloud/dist/huzhou-scrape.zip --function huzhou-epi-scrape
"""

import os
import sys
import json
import time
import base64
import hashlib
import hmac
import argparse
import urllib.request
import urllib.error

SERVICE = "scf"
HOST = "scf.tencentcloudapi.com"
ENDPOINT = "https://" + HOST
VERSION = "2018-04-16"
ALGO = "TC3-HMAC-SHA256"
CT = "application/json; charset=utf-8"


def _sha256(b):
    return hashlib.sha256(b if isinstance(b, bytes) else b.encode("utf-8")).hexdigest()


def _hmac(key, msg):
    return hmac.new(key if isinstance(key, bytes) else key.encode("utf-8"),
                    msg.encode("utf-8"), hashlib.sha256).digest()


def call(action, payload, sid, skey, region):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    now = int(time.time())
    date = time.strftime("%Y-%m-%d", time.gmtime(now))

    # 签名里写的 content-type 必须和实际发送的完全一致，否则 AuthFailure
    canon_headers = f"content-type:{CT}\nhost:{HOST}\n"
    signed_headers = "content-type;host"
    canon = ("POST\n/\n\n" + canon_headers + "\n" + signed_headers + "\n" + _sha256(body))

    scope = f"{date}/{SERVICE}/tc3_request"
    to_sign = f"{ALGO}\n{now}\n{scope}\n{_sha256(canon)}"

    k = _hmac(("TC3" + skey).encode("utf-8"), date)
    k = _hmac(k, SERVICE)
    k = _hmac(k, "tc3_request")
    sig = hmac.new(k, to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    auth = (f"{ALGO} Credential={sid}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={sig}")

    req = urllib.request.Request(
        ENDPOINT, data=body, method="POST",
        headers={
            "Authorization": auth,
            "Content-Type": CT,
            "Host": HOST,
            "X-TC-Action": action,
            "X-TC-Timestamp": str(now),
            "X-TC-Version": VERSION,
            "X-TC-Region": region,
        })

    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return json.loads(raw)
        except Exception:
            return {"Response": {"Error": {"Code": str(e.code), "Message": raw[:500]}}}
    except Exception as e:
        return {"Response": {"Error": {"Code": "ClientError", "Message": repr(e)}}}


def unwrap(resp, what):
    r = resp.get("Response", {})
    if "Error" in r:
        err = r["Error"]
        print(f"✗ {what} 失败：{err.get('Code')} - {err.get('Message')}")
        return None
    return r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", default="ap-shanghai")
    ap.add_argument("--function", default="huzhou-epi-scrape")
    ap.add_argument("--zip", default="cloud/dist/huzhou-scrape.zip")
    ap.add_argument("--token", default=None, help="SCRAPE_TOKEN，不给就自动生成")
    ap.add_argument("--memory", type=int, default=512)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--runtime", default="Python3.10")
    args = ap.parse_args()

    sid = os.environ.get("TENCENTCLOUD_SECRET_ID", "").strip()
    skey = os.environ.get("TENCENTCLOUD_SECRET_KEY", "").strip()
    if not sid or not skey:
        sys.exit("请先设置环境变量 TENCENTCLOUD_SECRET_ID / TENCENTCLOUD_SECRET_KEY")

    zp = args.zip if os.path.isabs(args.zip) else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), args.zip)
    if not os.path.exists(zp):
        sys.exit(f"找不到 {zp}，先跑 ./cloud/build.sh")
    zdata = base64.b64encode(open(zp, "rb").read()).decode()
    print(f"▶ 代码包 {zp}（{os.path.getsize(zp)//1024} KB）")

    token = args.token or __import__("secrets").token_hex(24)
    env = {"Variables": [{"Key": "SCRAPE_TOKEN", "Value": token}]}

    # 1. 函数是否已存在
    exists = unwrap(call("GetFunction", {"FunctionName": args.function},
                         sid, skey, args.region), "查询函数")
    if exists is None and "ResourceNotFound" not in str(exists):
        pass

    if exists:
        print(f"▶ 函数已存在，更新代码和配置")
        r = unwrap(call("UpdateFunctionCode",
                        {"FunctionName": args.function, "ZipFile": zdata,
                         "Handler": "main.main_handler"},
                        sid, skey, args.region), "更新代码")
        if r is None:
            return 1
        r = unwrap(call("UpdateFunctionConfiguration",
                        {"FunctionName": args.function,
                         "MemorySize": args.memory, "Timeout": args.timeout,
                         "Environment": env},
                        sid, skey, args.region), "更新配置")
        if r is None:
            return 1
    else:
        print(f"▶ 创建函数 {args.function}（{args.runtime} / {args.memory}MB / {args.timeout}s）")
        r = unwrap(call("CreateFunction", {
            "FunctionName": args.function,
            "Code": {"ZipFile": zdata},
            "Handler": "main.main_handler",
            "Runtime": args.runtime,
            "MemorySize": args.memory,
            "Timeout": args.timeout,
            "Type": "Event",
            "Environment": env,
            "Description": "huzhou epi scrape (境内抓取，境外调度)",
        }, sid, skey, args.region), "创建函数")
        if r is None:
            return 1

    # 2. 开函数 URL（API 网关已停服，这是官方替代）
    print("▶ 开启函数 URL")
    desc = {
        "AuthType": "NONE",                       # 开放，函数内部自己校验 token
        "NetConfig": {"EnableExtranet": True, "EnableIntranet": False},
        "ApiGwCompatible": True,                  # 兼容 apigw 响应格式
        "CorsConfig": {"Enable": False, "Credentials": False, "MaxAge": 0},
    }
    r = unwrap(call("CreateTrigger", {
        "FunctionName": args.function,
        "Type": "http",
        "TriggerName": "url",
        "TriggerDesc": json.dumps(desc),
        "Qualifier": "$LATEST",
    }, sid, skey, args.region), "创建函数 URL")
    if r is None:
        print("  （可能已经建过了，继续读现有触发器）")

    # 3. 读回触发器，找 URL
    url = None
    r = unwrap(call("ListTriggers", {"FunctionName": args.function},
                    sid, skey, args.region), "读取触发器")
    if r:
        for t in r.get("Triggers", []) or []:
            if t.get("Type") == "http":
                try:
                    d = json.loads(t.get("TriggerDesc") or "{}")
                except Exception:
                    d = {}
                url = (d.get("Url") or d.get("url") or t.get("Url")
                       or d.get("SubnetId") or None)
                if not url:
                    print(f"  触发器原文：{json.dumps(t, ensure_ascii=False)[:600]}")
                break

    print()
    print("=" * 62)
    print(f"函数名     {args.function}")
    print(f"地域       {args.region}")
    print(f"SCRAPE_TOKEN  {token}")
    if url:
        print(f"函数 URL   {url}")
    else:
        print("函数 URL   已创建，但 API 没返回地址；")
        print("           去控制台 函数详情 → 函数 URL 里复制一下")
    print("=" * 62)
    print()
    print("下一步：把上面两项填进 GitHub 仓库的 Secrets")
    print("  SCRAPE_URL   = 函数 URL")
    print(f"  SCRAPE_TOKEN = {token}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
