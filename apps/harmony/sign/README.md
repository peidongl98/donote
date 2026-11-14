# 签名材料（不入库）

这个目录里的私钥和证书**不进版本库**（`.gitignore` 已排除，只留这份说明）。

| 文件 | 是什么 | 从哪儿来 |
|---|---|---|
| `donote.key` | 私钥（ECC P-384） | 本地生成 |
| `donote.self.crt` | 配套的自签证书，只为生成 p12 用 | 本地生成 |
| `donote.p12` | 密钥库，打包签名时读它 | 本地生成 |
| `donote.csr` | 证书请求文件 | 本地生成，已上传 AGC |
| `donote.cer` | 华为签发的调试证书（含证书链） | AGC「证书」页下载 |
| `donote.p7b` | Profile，绑定应用 + 证书 + 设备 UDID | AGC「Profile」页下载，**待补** |
| `.storepass` | `donote.p12` 的密码 | 本地生成 |

## 还差哪一步

Profile（`.p7b`）要等设备 UDID 读出来、在 AGC 里登记之后才能申请。

## 到期

- 调试证书 1 年，Profile **180 天**。过期后应用**直接打不开**（不是闪退）。
- 续期只需重新下载 Profile、重新打包重装，不需要换密钥 —— 前提是这几个文件都还在。

## 配置到哪

`apps/harmony/build-profile.json5` 的 `signingConfigs`：

```json5
"signingConfigs": [
  {
    "name": "default",
    "type": "HarmonyOS",
    "material": {
      "storeFile": "sign/donote.p12",
      "storePassword": "<.storepass 里的值>",
      "keyAlias": "donote",
      "keyPassword": "<同 storePassword>",
      "certpath": "sign/donote.cer",
      "profile": "sign/donote.p7b",
      "signAlg": "SHA384withECDSA"
    }
  }
]
```

`signingConfigs` 里加了之后，项目级 `build-profile.json5` 的 `products[0]` 要补一行 `"signingConfig": "default"`。
