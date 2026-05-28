#!/usr/bin/env python3
"""
backfill_comicinfo.py — 기존 CBZ 라이브러리에 ComicInfo.xml 백필/교정.

목적:
  - ComicInfo.xml이 없는 CBZ에 생성
  - <Title>을 파일명에서 복구 ("0001 - 외전" → "외전")  → Kavita에서 화 이름 표시
  - <Writer>에 박혀 있던 잘못된 값(룰 이름 등)을 info.json 작가로 교체(없으면 비움)
  - <Series>/<Number>/<PageCount>/<LanguageISO> 정리

안전장치:
  - 기본은 DRY-RUN (실제 변경 없음). 적용하려면 --apply
  - 파일별 임시파일 생성 후 os.replace로 원자적 교체 (중단되어도 원본 보존)
  - 원본 압축방식(STORED/DEFLATE) 보존, 이미지 재압축 안 함

사용:
  python3 backfill_comicinfo.py                 # 미리보기(dry-run)
  python3 backfill_comicinfo.py --apply         # 실제 적용
  python3 backfill_comicinfo.py --apply --cats Manga   # 특정 카테고리만
  python3 backfill_comicinfo.py --series "일곱개의 대죄"  # 특정 시리즈 이름 포함만
"""
import os, re, sys, json, glob, zipfile, tempfile, argparse

BOOKS = "/volume1/books"
IMG_EXT = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".avif", ".bmp")


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
            .replace('"', "&quot;").replace("'", "&apos;"))


def clean_series(folder_name):
    # "[14] 일곱개의 대죄" → "일곱개의 대죄"
    return re.sub(r'^\[[0-9A-Za-z_\-]+\]\s*', '', folder_name).strip()


def parse_chapter(filename, series_clean):
    """파일명에서 (number, title) 추출."""
    base = os.path.splitext(filename)[0]
    # 패턴 A: "0001 - 외전"
    m = re.match(r'^(\d+)\s*-\s*(.+)$', base)
    if m:
        return m.group(1), m.group(2).strip()
    # 패턴 B: "시리즈명_0001"
    m = re.match(r'^(.*)_(\d+)$', base)
    if m:
        num = m.group(2)
        return num, f"{int(num)}화"
    # 폴백: 앞쪽 숫자
    m = re.match(r'^(\d+)', base)
    if m:
        return m.group(1), base.strip()
    return "", base.strip()


def load_info(series_dir):
    p = os.path.join(series_dir, "info.json")
    if not os.path.exists(p):
        return {}
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return {}


def author_from_info(info):
    authors = (info.get("metadata") or {}).get("authors") or []
    for a in authors:
        if a and a.strip() and a.strip().lower() != "unknown":
            return a.strip()
    return ""


def norm_status(raw):
    if not raw:
        return ""
    t = re.sub(r"[●•\s]", "", str(raw))
    if re.search(r"완결|completed|complete|end|finished", t, re.I):
        return "완결"
    if re.search(r"연재|연중|진행|ongoing|serializing", t, re.I):
        return "연재중"
    return ""


def status_from_info(info):
    return norm_status((info.get("metadata") or {}).get("status"))


def build_comicinfo(series, number, title, writer, pagecount, genre=""):
    lines = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
        f'  <Series>{esc(series)}</Series>',
        f'  <Number>{esc(number)}</Number>',
        f'  <Title>{esc(title)}</Title>',
    ]
    if writer:
        lines.append(f'  <Writer>{esc(writer)}</Writer>')
    if genre:
        lines.append(f'  <Genre>{esc(genre)}</Genre>')
    lines += [
        '  <LanguageISO>ko</LanguageISO>',
        f'  <PageCount>{pagecount}</PageCount>',
        '</ComicInfo>',
    ]
    return "\n".join(lines)


def rewrite_cbz(cbz, xml):
    """ComicInfo.xml을 교체/추가하여 cbz 재작성 (원자적)."""
    d = os.path.dirname(cbz)
    fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp.cbz")
    os.close(fd)
    try:
        with zipfile.ZipFile(cbz) as zin, \
             zipfile.ZipFile(tmp, "w") as zout:
            for item in zin.infolist():
                if item.filename.lower().endswith("comicinfo.xml"):
                    continue  # 기존 것 제거
                # 원본 압축방식 보존
                zout.writestr(item, zin.read(item.filename))
            zout.writestr("ComicInfo.xml", xml)
        os.replace(tmp, cbz)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="실제 적용 (기본은 dry-run)")
    ap.add_argument("--cats", nargs="*", default=["Manga", "Webtoon"], help="카테고리")
    ap.add_argument("--series", default="", help="시리즈명에 이 문자열 포함된 폴더만")
    args = ap.parse_args()

    total = changed = errors = skipped = 0
    for cat in args.cats:
        cat_dir = os.path.join(BOOKS, cat)
        if not os.path.isdir(cat_dir):
            continue
        # 주의: 폴더명에 [id] 대괄호가 있어 glob 사용 금지 (문자클래스로 오인됨) → os.listdir
        for folder in sorted(os.listdir(cat_dir)):
            series_dir = os.path.join(cat_dir, folder)
            if not os.path.isdir(series_dir) or folder == "@eaDir":
                continue
            if args.series and args.series not in folder:
                continue
            info = load_info(series_dir)
            series_name = (info.get("title") or clean_series(folder)).strip()
            writer = author_from_info(info)
            genre = status_from_info(info)

            try:
                entries = os.listdir(series_dir)
            except OSError:
                continue
            cbzs = sorted(os.path.join(series_dir, f)
                          for f in entries if f.lower().endswith(".cbz"))
            for cbz in cbzs:
                total += 1
                fname = os.path.basename(cbz)
                number, title = parse_chapter(fname, series_name)
                try:
                    with zipfile.ZipFile(cbz) as z:
                        pagecount = sum(1 for n in z.namelist()
                                        if n.lower().endswith(IMG_EXT))
                    xml = build_comicinfo(series_name, number, title, writer, pagecount, genre)
                    if args.apply:
                        rewrite_cbz(cbz, xml)
                    changed += 1
                    if changed <= 8 or changed % 200 == 0:
                        print(f"  [{cat}] {series_name} | #{number} '{title}' "
                              f"writer='{writer}' pages={pagecount}")
                except Exception as e:
                    errors += 1
                    print(f"  !! ERROR {cbz}: {e}", file=sys.stderr)

    mode = "APPLIED" if args.apply else "DRY-RUN (변경 없음)"
    print(f"\n=== {mode} ===")
    print(f"총 {total}개 / 처리 {changed} / 오류 {errors} / 스킵 {skipped}")
    if not args.apply:
        print("실제 적용: python3 backfill_comicinfo.py --apply")


if __name__ == "__main__":
    main()
