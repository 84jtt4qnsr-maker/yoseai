#!/usr/bin/env python3
"""Nano Banana (Gemini Flash Image) で画像を生成して保存する。

使い方:
  python3 u2a2a/tools/nanobanana.py "プロンプト" 保存先.png [--model MODEL]

キーの置き場所（上から順に探す）:
  1. 環境変数 GEMINI_API_KEY
  2. u2a2a/data/gemini.key（1 行目にキー。data/ は gitignore 済み）

標準ライブラリのみ。モデルは既定で新しい順に試し、最初に成功したものを使う。
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_MODELS = ["gemini-3.1-flash-image", "gemini-2.5-flash-image"]
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def read_key():
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if key:
        return key
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "gemini.key")
    try:
        with open(path) as f:
            key = f.readline().strip()
    except OSError:
        key = ""
    if not key:
        sys.exit("キー未設定: 環境変数 GEMINI_API_KEY か u2a2a/data/gemini.key（1行目にキー）を用意してください。"
                 "キーは https://aistudio.google.com/apikey で取得できます。")
    return key


def generate(model, key, prompt):
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseModalities": ["TEXT", "IMAGE"]},
    }).encode()
    req = urllib.request.Request(
        ENDPOINT.format(model=model) + "?key=" + key,
        data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as res:
        data = json.load(res)
    for cand in data.get("candidates", []):
        for part in (cand.get("content") or {}).get("parts", []):
            blob = part.get("inlineData") or part.get("inline_data")
            if blob and blob.get("data"):
                return base64.b64decode(blob["data"]), blob.get("mimeType") or blob.get("mime_type") or ""
    raise RuntimeError("応答に画像が含まれませんでした: " + json.dumps(data, ensure_ascii=False)[:300])


def main():
    args = [a for a in sys.argv[1:]]
    model = None
    if "--model" in args:
        i = args.index("--model")
        model = args[i + 1]
        del args[i:i + 2]
    if len(args) != 2:
        sys.exit("使い方: python3 u2a2a/tools/nanobanana.py \"プロンプト\" 保存先.png [--model MODEL]")
    prompt, out = args
    key = read_key()
    errors = []
    for m in [model] if model else DEFAULT_MODELS:
        try:
            image, mime = generate(m, key, prompt)
            os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
            with open(out, "wb") as f:
                f.write(image)
            print(f"保存しました: {out}（{len(image)} bytes, {mime or 'image'}, model={m}）")
            return
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")[:200]
            errors.append(f"{m}: HTTP {e.code} {detail}")
            if e.code not in (404, 400, 429):  # モデル不在・クォータ系は次のモデルを試す
                break
        except Exception as e:  # noqa: BLE001 — CLI の最終報告
            errors.append(f"{m}: {e}")
            break
    sys.exit("画像生成に失敗しました:\n  " + "\n  ".join(errors))


if __name__ == "__main__":
    main()
