import json, sys, time

d = json.load(open(sys.argv[1], encoding="utf-8"))
fmt = d.get("format", 1)
ch = d.get("challenge", {})
protos = [c.get("protocol") for c in d.get("challenges", [])]

print()
print("协议代次      : format {}  ({})".format(
    fmt,
    "旧版 sha256-pow，无浏览器环境检测" if fmt == 1 else "新版，含 instrumentation",
))
if fmt == 1:
    bits = ch.get("d", 0) * 4
    expect = ch.get("c", 0) * (2 ** bits)
    print("工作量        : {} 个挑战 × {} nibble ≈ {:,.0f} 次 SHA-256 / token".format(
        ch.get("c"), ch.get("d"), expect))
else:
    print("协议          : {}".format(protos))
    print("浏览器环境检测: {}".format(
        "已启用（挑战里有 instrumentation 条目）" if "instrumentation" in protos else "未启用"))

ttl = round((d.get("expires", 0) - time.time() * 1000) / 60000)
print("挑战剩余有效期: {} 分钟".format(ttl))
print()
print("本脚本只取了一次 challenge，没有提交解、没有 redeem。")
