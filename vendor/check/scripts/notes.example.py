# -*- coding: utf-8 -*-
"""红笔订正的数据表（把这份复制成项目里的 notes.py 再改）。

    NOTES = { 块号: [ (目标行的中心 y, 红字 HTML), ... ] }

- **块号**：切片按 `--slices` 给的目录顺序编号，从 1 开始。
  例如 `--slices 切图1/按题分区 切图2/按题分区`，前 26 张是 1–26，接着 27、28…
- **y**：**切片图内部**的纵坐标，指到出错的那一行。用 locate.py 量：

      python -I <skill>/scripts/locate.py lines 14 --slices 切图1/按题分区 切图2/按题分区
      python -I <skill>/scripts/locate.py band  14 650 780 x2 --slices ...

  量出来的 `y0..y1` 里取中点写进来即可；红字会以这个 y 为中心贴在右侧页边，
  从切口拉一条红色折线指过去。
- **红字 HTML**：中文默认黑体；`$...$` 里的内容交给 MathJax 排（分数、根号、上下标都规整）。
  这是 HTML 不是 Markdown，**加粗要写 `<b>…</b>`**，写 `**…**` 会原样显示星号。
- 一个块可以有多条 `(y, html)`，会按 y 从上到下排开，互相自动让位。

改完直接重跑 `python -I redpen.py`：HTML 没变的条目会跳过截图，只重做改动过的那几条。

下面两条是可选的，写在这里之后 `python -I redpen.py` 就不用带参数了：
    SLICES = [r"切图1/按题分区", r"切图2/按题分区"]     # 相对路径按「本文件所在目录」找
    OUT    = r"图片_手写订正"
"""

NOTES = {
    # 14: [
    #     (60,  r"订正：这里不能停。$\sqrt{(1-u)(1-2u)}=\sqrt{1-3u+2u^2}"
    #           r"=1-\frac32u-\frac18u^2+\cdots$（$u=\sin^2x\sim x^2$），故原式 $\to\frac32$。"),
    #     (717, r"订正：$n\sqrt n\cdot\frac{x}{\sqrt n}=nx$，少写了一个因子 $x$。"
    #           r"保留后为 $\frac{x^3}2$，不是 $\frac{x^2}2$。"),
    # ],
    #
    # 19: [
    #     (694, r"订正：$\frac2{1+\sqrt x}$ 不能当成常数 $2$。展开为 $2-2\sqrt x+2x-\cdots$，"
    #           r"其中 $-2\sqrt x$ 与前面的 $+2\sqrt x$ 相消，故原式 $=x+x^{3/2}+\cdots$："
    #           r"是 <b>1 阶</b>无穷小，主部为 $x$。"),
    # ],
}
