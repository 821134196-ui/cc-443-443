#!/usr/bin/env python3
"""本地启动入口：导入样例并启动服务（零第三方依赖）。

用法: python3 run.py [--port 8077] [--no-seed] [--reset]
"""
import argparse
import sys

from app.db import DB_PATH
from app.seed import seed
from app.server import build_server


def main() -> None:
    parser = argparse.ArgumentParser(description="母婴室巡检与耗材补给系统")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8077)
    parser.add_argument("--no-seed", action="store_true", help="不导入样例数据")
    parser.add_argument("--reset", action="store_true", help="删除数据库后重新导入样例")
    args = parser.parse_args()

    if args.reset and DB_PATH.exists():
        for p in (DB_PATH, DB_PATH.with_suffix(".db-wal"), DB_PATH.with_suffix(".db-shm")):
            p.unlink(missing_ok=True)

    if not args.no_seed:
        created = seed(force=args.reset)
        if args.reset:
            print("已重置并导入巡检样例")
        elif created:
            print("巡检样例导入完成")
        else:
            print("检测到已有数据，跳过样例导入")

    httpd = build_server(args.host, args.port)
    print(f"\n  商场母婴室巡检系统  http://{args.host}:{args.port}\n", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
        sys.exit(0)


if __name__ == "__main__":
    main()
