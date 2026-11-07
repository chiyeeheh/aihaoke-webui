# -*- coding: utf-8 -*-
"""hw_clean.py — 作业目录收尾清理（hw 系列 skill 通用，四个 skill 的 scripts/ 里各放一份）。

交付完成后删掉运行副产物，只保留三类最终交付物和源材料：

保留：
  1. 最终校对好的题面图        *_题面图/（含 对照表.md）
  2. 手写稿 / 教材等 PDF       *.pdf（任何 PDF 一律不碰）
  3. 最终输出的图片切片        图片_手写订正/（订正版）、(*_转换)/ 里的 图片/ 与 题面_大/
                               （latex 图片版）、顶层的 按题分区/ 与 图片/（手写图片版）
  另：*_原题/（自备原题材料）也保留。

删除的副产物：
  切图*/（工作区+中间切片，若其中按题分区是唯一手写切片则先移出保全）、
  *_haoke/（网页原始截图与题面文本.json）、教材页/、notes.py、_redpen/ 等
  下划线开头目录、__pycache__/、*校对总览.png、任意 .py，以及
  *_转换/ 里除保留项外的全部内容（页面/、latex/、报告.md、辅助脚本等）。

用法：
  python -I hw_clean.py <作业目录>             # 实际删除
  python -I hw_clean.py <作业目录> --dry-run   # 只列出将删除的内容，不删
"""
import os
import shutil
import sys

KEEP_DIR = {"图片_手写订正", "图片", "按题分区", "题面_大"}


def is_keep_dir(name: str) -> bool:
    return (name in KEEP_DIR
            or name.endswith("_题面图")
            or name.endswith("_原题"))


def find_column_gap(im_band, lo=0.35, hi=0.75):
    """在行带里找 lo..hi 之间最长的空白列缝隙，返回缝隙中心（比例）。找不到返回 None。"""
    import numpy as np
    g = np.array(im_band.convert("L"))
    blank = (g >= 160).all(axis=0)
    best, best_len, run, start = None, 0, 0, None
    for x in range(int(lo * len(blank)), int(hi * len(blank))):
        if blank[x]:
            if start is None:
                start = x
            run = x - start + 1
            if run > best_len:
                best_len, best = run, start + run // 2
        else:
            start, run = None, 0
    return best


def clean_transform(path, dry, removed):
    """清理 *_转换 目录：只保留 图片/、图片_手写订正/、题面_大/。"""
    for entry in sorted(os.listdir(path)):
        full = os.path.join(path, entry)
        if entry in ("图片", "图片_手写订正", "题面_大"):
            continue
        removed.append(full + os.sep)
        if not dry:
            if os.path.isdir(full):
                shutil.rmtree(full, ignore_errors=True)
            else:
                os.remove(full)


def clean_assignment(root: str, dry: bool) -> list:
    removed = []
    for entry in sorted(os.listdir(root)):
        full = os.path.join(root, entry)
        if os.path.isdir(full):
            if is_keep_dir(entry):
                continue
            if "转换" in entry:
                clean_transform(full, dry, removed)
                continue
            if entry.startswith("切图"):
                # 工作区：若里面的 按题分区 是唯一的手写切片（没有订正版交付），先移出保全
                inner = os.path.join(full, "按题分区")
                has_fixed = any(os.path.isdir(os.path.join(root, d))
                                for d in os.listdir(root)
                                if d.startswith("图片_手写订正"))
                if os.path.isdir(inner) and not has_fixed:
                    dst = os.path.join(root, "按题分区")
                    removed.append(full + os.sep + " （按题分区 已移至 " + dst + "）")
                    if not dry:
                        shutil.move(inner, dst)
                else:
                    removed.append(full + os.sep)
                if not dry:
                    shutil.rmtree(full, ignore_errors=True)
                continue
            if entry == "__pycache__" or entry.startswith("_") or entry.endswith("_haoke") \
                    or entry == "教材页":
                removed.append(full + os.sep)
                if not dry:
                    shutil.rmtree(full, ignore_errors=True)
                continue
            # 其他未知目录：保留（宁滥勿缺）
            continue
        # 文件
        if entry.lower().endswith(".pdf") or entry == "对照表.md":
            continue
        if entry == "notes.py" or entry == "题面文本.json" \
                or entry.endswith("校对总览.png") or entry.endswith(".py"):
            removed.append(full)
            if not dry:
                os.remove(full)
    return removed


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    if not args:
        print(__doc__)
        sys.exit(1)
    root = os.path.abspath(args[0])
    if not os.path.isdir(root):
        print(f"目录不存在：{root}")
        sys.exit(1)
    removed = clean_assignment(root, dry)
    tag = "将删除" if dry else "已删除"
    for r in removed:
        print(f"{tag}: {r}")
    print(f"DONE {'(dry-run)' if dry else ''} {len(removed)} 项"
          f" -> 保留：题面图 / PDF 手写稿 / 最终图片切片 / 原题材料")


if __name__ == "__main__":
    main()
