"""模拟温度适配器：为热水设备提供读数（无真实硬件）。

可用两种方式制造异常：
1. 环境变量 MB_TEMP_OVERRIDES='{"<facility_code>": 52.0}' 固定覆盖；
2. 适配器内置场景脚本（样例演示用），按读数序号演变。
"""
from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass

from . import config


@dataclass
class TempReading:
    value_c: float
    status: str  # ok / high / low


class MockTemperatureAdapter:
    """进程内模拟器；真实部署可替换成串口/HTTP 适配器，接口保持 read(code)。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._ticks: dict[str, int] = {}
        overrides = os.environ.get("MB_TEMP_OVERRIDES", "")
        self._overrides: dict[str, float] = {}
        if overrides:
            try:
                self._overrides = {k: float(v) for k, v in json.loads(overrides).items()}
            except (ValueError, TypeError):
                self._overrides = {}
        # 演示场景：指定设备第 N 次读数的温度序列，之后保持末值
        self._scenarios: dict[str, list[float]] = {}

    def set_scenario(self, code: str, values: list[float]) -> None:
        with self._lock:
            self._scenarios[code] = list(values)
            self._ticks[code] = 0

    def read(self, code: str) -> TempReading:
        with self._lock:
            if code in self._overrides:
                value = self._overrides[code]
            else:
                seq = self._scenarios.get(code)
                if seq:
                    i = min(self._ticks[code], len(seq) - 1)
                    value = seq[i]
                    self._ticks[code] += 1
                else:
                    # 基线 41.0°C，确定性微抖动（不使用随机数，便于测试复现）
                    n = self._ticks.get(code, 0)
                    value = 41.0 + (0.4 if n % 3 == 0 else -0.2)
                    self._ticks[code] = n + 1
        if value > config.WATER_MAX_C:
            status = "high"
        elif value < config.WATER_MIN_C:
            status = "low"
        else:
            status = "ok"
        return TempReading(round(value, 1), status)


adapter = MockTemperatureAdapter()
