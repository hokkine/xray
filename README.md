# 上机助手 Chrome 扩展

这个扩展会使用浏览器里 `xx.78sjz.com` 当前登录态 cookie 拉取设备列表，发现 `kdqzt=空闲` 的设备后提醒，或在开启“自动提交上机”后调用上机接口。

## 使用

1. Chrome 打开 `chrome://extensions/`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录：`/Users/xushuo10/Desktop/Develop/project/xray`。
4. 在浏览器里正常登录并打开 `http://xx.78sjz.com/ezweb/wd/User/index.jsp?id=1019`。
5. 点扩展图标，确认 `roomCode`、`mode` 和 `captchaAction`，再开始监控。

## 配置

- `roomCode`：默认 `TFP6314`，提交上机时使用。
- `mode`：默认 `2`。
- `间隔秒`：最小 30 秒。
- `指定机器`：可填机器号、标题或设备 ID，多个值用空格或逗号分隔；留空则使用排序后的第一台空闲机。
- `自动提交上机`：关闭时只提醒并等待手动点击提交；开启时命中后提交一次并停止监控。

扩展不会保存你贴出来的 `JSESSIONID`。如果列表拉取失败，通常是网页登录态过期，重新登录后再点“拉取一次”即可。
