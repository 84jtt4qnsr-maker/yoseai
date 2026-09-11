#!/usr/bin/env python3
"""アバターの共通 v2 定義と静止画を pool/avatars/ に生成する（仕様: SPEC-アバター状態.md §8・§9）。

使い方:
  python3 u2a2a/tools/avatar-assets.py [--pool u2a2a/pool] [--check]

- 各 pool/avatars/<agent>/spritesheet.webp の実寸と、行ごとの使用コマ（不透明画素の有無）を
  下の定義と突き合わせる。食い違いがあれば何も書かずに終了コード 1
- pool/avatars/v2-format.json を書く
- r0c0（idle 先頭）を pool/avatars/<agent>/still-r0c0.webp に切り出す
- 内容が変わらないファイルは書き直さない（配信 URL のハッシュを無駄に変えない）
- --check は検証だけ行い、書き込まない

依存: Pillow（サーバは使わない。資産の生成時だけ）
"""
import argparse
import io
import json
import os
import sys

from PIL import Image

AGENTS = ["claude", "codex", "grok"]
ALPHA_MIN = 8  # これ以下の不透明度は「空」とみなす（縁のノイズ）
STILL_PARAMS = {"quality": 88, "method": 6}  # 合意メモ §5 の実測と同じ

FORMAT = {
    "spriteVersionNumber": 2,
    "atlas": {"width": 1536, "height": 2288, "columns": 8, "rows": 11, "cellWidth": 192, "cellHeight": 208},
    "animations": [
        {"row": 0, "name": "idle", "frames": 6, "durationsMs": [280, 110, 110, 140, 140, 320]},
        {"row": 1, "name": "running-right", "frames": 8, "durationsMs": [120] * 7 + [220]},
        {"row": 2, "name": "running-left", "frames": 8, "durationsMs": [120] * 7 + [220]},
        {"row": 3, "name": "waving", "frames": 4, "durationsMs": [140] * 3 + [280]},
        {"row": 4, "name": "jumping", "frames": 5, "durationsMs": [140] * 4 + [280]},
        {"row": 5, "name": "failed", "frames": 8, "durationsMs": [140] * 7 + [240]},
        {"row": 6, "name": "waiting", "frames": 6, "durationsMs": [150] * 5 + [260]},
        {"row": 7, "name": "running", "frames": 6, "durationsMs": [120] * 5 + [220]},
        {"row": 8, "name": "review", "frames": 6, "durationsMs": [150] * 5 + [280]},
    ],
    "look": {"rows": [9, 10], "framesPerRow": 8, "stepDeg": 22.5, "zeroDeg": "up", "clockwise": True},
    "neutral": {"row": 0, "col": 6},
}


def expected_cols(row):
    """行ごとに「絵が入っているべき列」の集合。neutral は任意（有っても無くてもよい）"""
    fmt = FORMAT
    if row in fmt["look"]["rows"]:
        return set(range(fmt["look"]["framesPerRow"])), set()
    anim = next(a for a in fmt["animations"] if a["row"] == row)
    optional = {fmt["neutral"]["col"]} if row == fmt["neutral"]["row"] else set()
    return set(range(anim["frames"])), optional


def occupied(cell):
    return cell.getchannel("A").point(lambda v: 255 if v > ALPHA_MIN else 0).getbbox() is not None


def check_atlas(agent, atlas):
    a = FORMAT["atlas"]
    errors, notes = [], []
    if atlas.size != (a["width"], a["height"]):
        return [f"{agent}: アトラス寸法 {atlas.size} ≠ 定義 {(a['width'], a['height'])}"], notes
    if atlas.mode != "RGBA":
        atlas = atlas.convert("RGBA")
    for row in range(a["rows"]):
        want, optional = expected_cols(row)
        for col in range(a["columns"]):
            box = (col * a["cellWidth"], row * a["cellHeight"], (col + 1) * a["cellWidth"], (row + 1) * a["cellHeight"])
            has = occupied(atlas.crop(box))
            if col in want and not has:
                errors.append(f"{agent}: r{row}c{col} は定義上コマがあるはずだが空")
            elif col not in want and col not in optional and has:
                errors.append(f"{agent}: r{row}c{col} は定義外だが絵がある")
            elif col in optional:
                notes.append(f"{agent}: neutral r{row}c{col} {'あり' if has else 'なし'}")
    for anim in FORMAT["animations"]:
        if len(anim["durationsMs"]) != anim["frames"]:
            errors.append(f"定義: {anim['name']} の durationsMs 長 {len(anim['durationsMs'])} ≠ frames {anim['frames']}")
    return errors, notes


def write_if_changed(path, data):
    try:
        with open(path, "rb") as f:
            if f.read() == data:
                return False
    except OSError:
        pass
    with open(path, "wb") as f:
        f.write(data)
    return True


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", default=os.path.join(here, "..", "pool"))
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    root = os.path.join(os.path.abspath(args.pool), "avatars")

    errors, found, stills = [], [], {}
    for agent in AGENTS:
        sheet = os.path.join(root, agent, "spritesheet.webp")
        if not os.path.isfile(sheet):
            print(f"  {agent}: spritesheet.webp なし（スキップ）")
            continue
        atlas = Image.open(sheet)
        atlas.load()
        errs, notes = check_atlas(agent, atlas)
        errors += errs
        for n in notes:
            print("  " + n)
        found.append(agent)
        a = FORMAT["atlas"]
        cell = atlas.convert("RGBA").crop((0, 0, a["cellWidth"], a["cellHeight"]))
        buf = io.BytesIO()
        cell.save(buf, "WEBP", **STILL_PARAMS)
        stills[agent] = buf.getvalue()

    if not found:
        print("アトラスが 1 体もありません: " + root)
        return 1
    if errors:
        print("定義とアトラスが食い違っています（何も書きません）:")
        for e in errors:
            print("  - " + e)
        return 1
    print(f"検証 OK: {', '.join(found)}（{FORMAT['atlas']['columns']}x{FORMAT['atlas']['rows']}、全行のコマ数が定義と一致）")
    if args.check:
        return 0

    fmt_bytes = (json.dumps(FORMAT, ensure_ascii=False, indent=2) + "\n").encode()
    fmt_path = os.path.join(root, "v2-format.json")
    print(f"  {'書き込み' if write_if_changed(fmt_path, fmt_bytes) else '変更なし'}: {fmt_path}（{len(fmt_bytes):,} B）")
    total = 0
    for agent, data in stills.items():
        p = os.path.join(root, agent, "still-r0c0.webp")
        print(f"  {'書き込み' if write_if_changed(p, data) else '変更なし'}: {p}（{len(data):,} B）")
        total += len(data)
    print(f"  静止画 合計 {total:,} B")
    return 0


if __name__ == "__main__":
    sys.exit(main())
