# T5AI 手机热点配网

本工程使用 TuyaOpen 官方 `netmgr + BLE netcfg + tuya_iot` 流程。未激活的 T5
启动后自动广播 BLE 配网服务；Tuya App 下发 Wi-Fi 名称、密码和激活 token。成功后
网络信息保存在设备 KV 中，后续开机自动重连，不需要把手机热点密码编译进 T5 固件。

## 推荐拓扑

- iPhone A：开启“个人热点”“允许其他人加入”和“最大兼容性”，并在首次连接期间停留
  在个人热点页面。热点名称是 iPhone A 的设备名称。
- iPhone B：先连接 iPhone A 的热点，再打开蓝牙，并给“智能生活”或“涂鸦智能”授予
  蓝牙、本地网络和定位权限。
- T5、ESP32-CAM、ESP32-S3 和 Agent 主机最终必须处于同一个 2.4 GHz 局域网。

不建议让同一台 iPhone 同时提供个人热点和执行 BLE 配网；iOS 在这种组合下的网络
发现和热点关联不稳定。两台手机的 Apple ID 可以不同。

## 首次配网

1. 烧录最新 T5 固件并让设备正常启动。
2. T5 显示 listening 表情时，在 iPhone B 打开“智能生活”或“涂鸦智能”。
3. 点右上角 `+`，选择“添加设备”，等待蓝牙自动发现；设备广播名可能显示为
   `TYBLE`，产品页应显示 `HSHH-Robot`。
4. 选择 iPhone A 的热点，输入该热点密码并开始配网。
5. 保持两台手机和 T5 靠近，不要关闭 iPhone A 的热点页面。
6. App 显示添加成功且 T5 切换为 happy 表情后，等待设备在产品页显示在线。

配网只支持 2.4 GHz。iPhone 的“最大兼容性”会将个人热点切换到兼容的 2.4 GHz
模式。

## 重新配网

设备激活后不会再次自动进入首次配网。需要换热点时，优先在 Tuya App 中删除设备并
选择清除数据；也可以在 5 秒窗口内连续重启 T5 三次。第三次启动会清除本地激活和
Wi-Fi 信息并重新广播 BLE 配网服务。

## 验证

- iPhone A 的个人热点已出现新的客户端。
- Tuya App 中 `HSHH-Robot` 显示在线。
- T5 配网时显示 listening，激活和 MQTT 连接成功时显示 happy。
- T5 的 Agent/LAN 线程复用同一条已配网络，不会再发起第二次固定 SSID 连接。

T5 的 USB 下载口是 UART0，完整应用日志在 UART1（GPIO0 TX/GPIO1 RX，460800 baud）。
USB UART0 上可通过 CLI 执行 `hshh_status`，安全查看配网阶段、Wi-Fi、激活、MQTT、
最近 IoT 错误、运行时间和复位原因；该命令不会输出 SSID、密码、token、UUID 或 AuthKey。
需要查看完整 `PR_*` 日志时，仍需使用共地的 3.3 V USB-to-UART 转接器连接 UART1。
