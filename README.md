# 航段与机场接驳资料接口

所有服务都在本机回环地址运行，数据及组织名称均为合成演练资料。重启来源服务会复位演练资料和当次受理记录。

## 运行

使用 Node.js 22.23.4。
运行 `npm start` 启动演练来源，默认地址为 `http://127.0.0.1:3100`，通过 `PORT` 修改端口。
运行 `npm test` 检查来源服务和原始资料。

`requests/example.json` 是业务人员提交的样例请求。
启动后处于演练阶段 0。可向 `POST /replay/phase` 发送 JSON `{"phase":1}` 切换到下一批资料。阶段切换不会清除此前受理的经办号。

## 来源接口

- `GET /airport/bulletin` 生效时间含时区。exception 仅约束对应的物理航段和起降角色。
- `GET /carrier/operations` leg 为实际运营航段，serviceDay 按始发站。UTC 时刻以 Z 结尾。recurrence 标识返航后重开的实际运行。
- `GET /airport/transfer` 单程接驳适用窗口按机场本地时刻，末班时刻含该分钟。跨机场手续中的分钟数另计。
- `GET /airport/desks` 柜台记录对应机场、承运人及可重办托运的当地时段。
