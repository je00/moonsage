# 节点实时状态 / Live node telemetry

在 **内网节点 → 列表 / 节点连接** 查看。无需配置。

| 显示 | 含义 |
|---|---|
| ↑ / ↓ | 节点发往 VPS / 从 VPS 接收，不区分内外网用途 |
| B/s | 每秒字节；K、M、G 按 1024 进位，不是 bit/s |
| 有流量 | 两次采样间计数增加，不等于在线探测 |
| 近期握手 | 最近 180 秒有 AWG 握手，不保证此刻连通 |
| 采样中 / 重新采样 | 尚无有效速率；不以 0 代替缺失数据 |
| 数据已过期 | 超过 8 秒没有新样本，隐藏旧速率 |
| 未开启统计 / 未知 | 未启用统计或读取失败，显示 —，不伪装成 0 |

- 可见页面每 2 秒刷新；后台页面暂停，失败时逐步退避。
- 数据新旧按 VPS 提供的样本年龄和浏览器经过时间判断，不受手机或电脑时钟偏差影响。
- AWG 由管理代理共享采样，只读计数，不执行连通性探测。
- VLESS 汇总该节点的内网身份与专属出口身份，只读 VPS 本地 Unix socket；不开放统计端口，不公开 UUID、凭据或原始计数。
- AWG 显示隧道字节；VLESS 显示有效数据字节，不含全部协议开销。AWG 隧道外另开的代理连接不计入 AWG；两者不盲目相加，避免嵌套代理重复计算。
- 节点图的权限配置每 30 秒刷新；切换已查看节点复用短期缓存，手动刷新立即重读。
- 首次采样、计数回退、接口或节点身份变化、超过 10 秒断档，先重建基线。
- Xray 重启或参与统计的出口身份变化也会重新采样。首次启用 VLESS 统计需要重启 Xray，日常刷新只读、不重启服务。
- VPS 中心不显示不完整的合计；权限线与节点状态独立，状态不改变授权。

## English

Open **内网节点** (Nodes), in list or graph view. No setup is needed.

- **↑ upload / ↓ download:** node → VPS / VPS → node; bytes/s, not bits/s, for both private and Internet traffic.
- Visible pages refresh every **2 seconds**. Hidden pages pause. Samples older than **8 seconds** show no rate.
- Freshness uses server-reported sample age and elapsed time, not your device's clock.
- AWG uses shared, read-only counter samples. A recent handshake is not a live connectivity check.
- VLESS combines the node's private-access and dedicated-exit identities through a local Unix socket, with no statistics TCP port. UUIDs and raw counters never reach the browser.
- AWG counts tunnel bytes; VLESS counts payload bytes. Separate proxy connections outside AWG are not part of its tunnel rate. The two are not blindly added, avoiding nested-proxy double counting.
- Missing or reset samples show **—**, not a false zero. Xray restarts and changed counter identities rebuild the baseline. Initial statistics setup restarts Xray; polling never does.
- Graph permissions refresh every **30 seconds**. Manual refresh bypasses the browser cache. Status never changes access rules.
