import React, { useCallback, useEffect, useRef } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickData, LineData, LineSeries, CandlestickSeries, createSeriesMarkers } from 'lightweight-charts';

export interface HoverOHLC {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface OverlayLine {
  id: string;
  color: string;
  lineWidth?: number;
  data: Array<{
    time: number;
    value: number;
  }>;
}

export interface ChartMarker {
  id: string;
  time: number;
  color: string;
  position?: 'aboveBar' | 'belowBar' | 'inBar';
  shape?: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  text?: string;
}

interface ChartComponentProps {
  data: any[];
  type?: 'candlestick' | 'line';
  onHoverOHLC?: (ohlc: HoverOHLC | null) => void;
  overlayLines?: OverlayLine[];
  markers?: ChartMarker[];
  fixedHeight?: number;
}

const normalizeTime = (rawTime: any): number | null => {
  if (rawTime === null || rawTime === undefined || rawTime === '') {
    return null;
  }

  const numeric = Number(rawTime);
  if (!Number.isFinite(numeric)) {
    return null;
  }

  const normalized = numeric > 9999999999 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  return normalized > 0 ? normalized : null;
};

const normalizeNumeric = (rawValue: any): number | null => {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }

  const numeric = Number(rawValue);
  return Number.isFinite(numeric) ? numeric : null;
};

const dedupeByTime = <T extends { time: any }>(rows: T[]): T[] => {
  if (rows.length <= 1) {
    return rows;
  }

  const out: T[] = [];
  for (const row of rows) {
    const currentTime = Number(row.time);
    const last = out[out.length - 1];
    if (last && Number(last.time) === currentTime) {
      out[out.length - 1] = row;
      continue;
    }
    out.push(row);
  }

  return out;
};

const extractCrosshairTime = (time: any): number | null => {
  if (time === null || time === undefined) {
    return null;
  }

  if (typeof time === 'number') {
    return Math.floor(time);
  }

  if (typeof time === 'string') {
    const parsed = Number(time);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }

  if (typeof time === 'object' && 'timestamp' in time) {
    const parsed = Number((time as any).timestamp);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }

  if (typeof time === 'object' && 'year' in time && 'month' in time && 'day' in time) {
    const { year, month, day } = time as { year: number; month: number; day: number };
    return Math.floor(Date.UTC(year, month - 1, day) / 1000);
  }

  return null;
};

const areSameOHLC = (left: HoverOHLC | null, right: HoverOHLC | null): boolean => {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  const epsilon = 1e-9;

  return (
    left.time === right.time &&
    Math.abs(left.open - right.open) < epsilon &&
    Math.abs(left.high - right.high) < epsilon &&
    Math.abs(left.low - right.low) < epsilon &&
    Math.abs(left.close - right.close) < epsilon
  );
};

const calculateChartHeight = (width: number): number => {
  if (!Number.isFinite(width) || width <= 0) {
    return 320;
  }

  if (width < 480) {
    return 260;
  }

  if (width < 880) {
    return 320;
  }

  return 400;
};

const ChartComponent: React.FC<ChartComponentProps> = ({ data, type = 'candlestick', onHoverOHLC, overlayLines = [], markers = [], fixedHeight }) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | ISeriesApi<'Line'> | null>(null);
  const overlaySeriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map());
  const markerPluginRef = useRef<any>(null);
  const onHoverRef = useRef<((ohlc: HoverOHLC | null) => void) | undefined>(onHoverOHLC);
  const lastHoverRef = useRef<HoverOHLC | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const lastSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  useEffect(() => {
    onHoverRef.current = onHoverOHLC;
  }, [onHoverOHLC]);

  const emitHover = useCallback((value: HoverOHLC | null) => {
    if (!onHoverRef.current) {
      return;
    }

    if (areSameOHLC(lastHoverRef.current, value)) {
      return;
    }

    lastHoverRef.current = value;
    onHoverRef.current(value);
  }, []);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    const overlaySeriesMap = overlaySeriesRef.current;
    const initialWidth = chartContainerRef.current.clientWidth || 320;

    const chart = createChart(chartContainerRef.current, {
      width: initialWidth,
      height: Number.isFinite(Number(fixedHeight)) && Number(fixedHeight) > 40 ? Number(fixedHeight) : calculateChartHeight(initialWidth),
      layout: {
        background: { color: '#ffffff' },
        textColor: '#000000',
      },
      grid: {
        vertLines: { color: '#e1e1e1' },
        horzLines: { color: '#e1e1e1' },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
      },
    });

    chartRef.current = chart;

    if (type === 'candlestick') {
      const candlestickSeries = chart.addSeries(CandlestickSeries, {});
      seriesRef.current = candlestickSeries;
      markerPluginRef.current = createSeriesMarkers(candlestickSeries as any, []);
    } else {
      const lineSeries = chart.addSeries(LineSeries, {});
      seriesRef.current = lineSeries;
      markerPluginRef.current = null;
    }

    return () => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      if (markerPluginRef.current && typeof markerPluginRef.current.detach === 'function') {
        markerPluginRef.current.detach();
      }
      markerPluginRef.current = null;
      overlaySeriesMap.clear();
      chart.remove();
    };
  }, [type]);

  useEffect(() => {
    if (!chartRef.current || !chartContainerRef.current) {
      return;
    }

    const chart = chartRef.current;
    const container = chartContainerRef.current;

    const scheduleResize = () => {
      if (resizeFrameRef.current !== null) {
        return;
      }

      resizeFrameRef.current = requestAnimationFrame(() => {
        resizeFrameRef.current = null;

        const width = container.clientWidth || 320;
        const height = Number.isFinite(Number(fixedHeight)) && Number(fixedHeight) > 40
          ? Number(fixedHeight)
          : calculateChartHeight(width);
        const lastSize = lastSizeRef.current;

        if (lastSize.width === width && lastSize.height === height) {
          return;
        }

        lastSizeRef.current = { width, height };
        chart.applyOptions({ width, height });
        chart.timeScale().fitContent();
        chart.timeScale().scrollToRealTime();
      });
    };

    scheduleResize();

    const handleWindowResize = () => scheduleResize();
    window.addEventListener('resize', handleWindowResize);
    window.addEventListener('orientationchange', handleWindowResize);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => scheduleResize());
      observer.observe(container);
    }

    return () => {
      if (resizeFrameRef.current !== null) {
        cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      window.removeEventListener('resize', handleWindowResize);
      window.removeEventListener('orientationchange', handleWindowResize);
      if (observer) {
        observer.disconnect();
      }
    };
  }, [type, fixedHeight]);

  useEffect(() => {
    if (!seriesRef.current) {
      return;
    }

    if (!Array.isArray(data) || data.length === 0) {
      if (type === 'candlestick') {
        (seriesRef.current as ISeriesApi<'Candlestick'>).setData([]);
      } else {
        (seriesRef.current as ISeriesApi<'Line'>).setData([]);
      }
      emitHover(null);
      return;
    }

    let chartData: CandlestickData[] | LineData[] = [];

    if (type === 'candlestick') {
      const processedCandles = dedupeByTime(
        data
          .map((d: any) => {
            if (Array.isArray(d) && d.length >= 5) {
              const normalizedTime = normalizeTime(d[0]);
              const open = normalizeNumeric(d[1]);
              const high = normalizeNumeric(d[2]);
              const low = normalizeNumeric(d[3]);
              const close = normalizeNumeric(d[4]);

              if (normalizedTime === null || open === null || high === null || low === null || close === null) {
                return null;
              }

              return {
                time: normalizedTime as any,
                open,
                high,
                low,
                close,
              };
            }

            if (d && typeof d === 'object' && d.time !== undefined) {
              const normalizedTime = normalizeTime(d.time);
              const open = normalizeNumeric(d.open);
              const high = normalizeNumeric(d.high);
              const low = normalizeNumeric(d.low);
              const close = normalizeNumeric(d.close);

              if (normalizedTime === null || open === null || high === null || low === null || close === null) {
                return null;
              }

              return {
                time: normalizedTime as any,
                open,
                high,
                low,
                close,
              };
            }

            return null;
          })
          .filter(
            (point): point is CandlestickData =>
              !!point &&
              Number.isFinite(point.open) &&
              Number.isFinite(point.high) &&
              Number.isFinite(point.low) &&
              Number.isFinite(point.close)
          )
          .sort((a, b) => Number(a.time) - Number(b.time))
      );

      chartData = processedCandles;
      try {
        (seriesRef.current as ISeriesApi<'Candlestick'>).setData(chartData as CandlestickData[]);
      } catch (error) {
        console.error('[ChartComponent] Failed to set candlestick data', error);
        (seriesRef.current as ISeriesApi<'Candlestick'>).setData([]);
        emitHover(null);
        return;
      }

      const latest = processedCandles[processedCandles.length - 1];
      if (latest) {
        emitHover({
          time: Number(latest.time),
          open: Number(latest.open),
          high: Number(latest.high),
          low: Number(latest.low),
          close: Number(latest.close),
        });
      }
    } else {
      const processedLine = dedupeByTime(
        data
          .map((d: any) => {
            if (Array.isArray(d) && d.length >= 5) {
              const normalizedTime = normalizeTime(d[0]);
              const value = normalizeNumeric(d[4]);

              if (normalizedTime === null || value === null) {
                return null;
              }

              return {
                time: normalizedTime as any,
                value,
              };
            }

            if (d && typeof d === 'object' && d.time !== undefined) {
              const normalizedTime = normalizeTime(d.time);
              const value = normalizeNumeric(d.value ?? d.close ?? d.equity);

              if (normalizedTime === null || value === null) {
                return null;
              }

              return {
                time: normalizedTime as any,
                value,
              };
            }

            return null;
          })
          .filter(
            (point): point is LineData => !!point && Number.isFinite(point.value)
          )
          .sort((a, b) => Number(a.time) - Number(b.time))
      );

      chartData = processedLine;
      try {
        (seriesRef.current as ISeriesApi<'Line'>).setData(chartData as LineData[]);
      } catch (error) {
        console.error('[ChartComponent] Failed to set line data', error);
        (seriesRef.current as ISeriesApi<'Line'>).setData([]);
        emitHover(null);
        return;
      }

      const latest = processedLine[processedLine.length - 1];
      if (latest) {
        const value = Number(latest.value);
        emitHover({
          time: Number(latest.time),
          open: value,
          high: value,
          low: value,
          close: value,
        });
      }
    }

    if (chartRef.current) {
      chartRef.current.timeScale().fitContent();
    }

  }, [data, type, emitHover]);

  useEffect(() => {
    if (!chartRef.current || !seriesRef.current) {
      return;
    }

    const chart = chartRef.current;
    const series = seriesRef.current;

    const handleCrosshairMove = (param: any) => {
      if (param?.time === undefined || param?.time === null || !param?.seriesData) {
        emitHover(null);
        return;
      }

      const point = param.seriesData.get(series as any) as any;
      if (!point) {
        emitHover(null);
        return;
      }

      const time = extractCrosshairTime(param.time);
      if (time === null) {
        emitHover(null);
        return;
      }

      if (point.open !== undefined && point.high !== undefined && point.low !== undefined && point.close !== undefined) {
        emitHover({
          time,
          open: Number(point.open),
          high: Number(point.high),
          low: Number(point.low),
          close: Number(point.close),
        });
        return;
      }

      if (point.value !== undefined) {
        const value = Number(point.value);
        emitHover({
          time,
          open: value,
          high: value,
          low: value,
          close: value,
        });
        return;
      }

      emitHover(null);
    };

    chart.subscribeCrosshairMove(handleCrosshairMove);

    return () => {
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
    };
  }, [type, data.length, emitHover]);

  useEffect(() => {
    if (!chartRef.current) {
      return;
    }

    const chart = chartRef.current;
    const existingIds = Array.from(overlaySeriesRef.current.keys());
    const incomingIds = new Set(overlayLines.map((line) => line.id));

    for (const id of existingIds) {
      if (!incomingIds.has(id)) {
        const series = overlaySeriesRef.current.get(id);
        if (series) {
          chart.removeSeries(series);
        }
        overlaySeriesRef.current.delete(id);
      }
    }

    for (const line of overlayLines) {
      if (!line || !line.id) {
        continue;
      }

      const normalized = dedupeByTime(
        (Array.isArray(line.data) ? line.data : [])
        .map((point) => {
          const normalizedTime = normalizeTime(point.time);
            const value = normalizeNumeric(point.value);

            if (normalizedTime === null || value === null || !Number.isFinite(value)) {
            return null;
          }

          return {
            time: normalizedTime as any,
            value,
          };
        })
        .filter((item): item is LineData => !!item)
          .sort((a, b) => Number(a.time) - Number(b.time))
      );

      if (normalized.length === 0) {
        const existing = overlaySeriesRef.current.get(line.id);
        if (existing) {
          chart.removeSeries(existing);
          overlaySeriesRef.current.delete(line.id);
        }
        continue;
      }

      let series = overlaySeriesRef.current.get(line.id);
      if (!series) {
        series = chart.addSeries(LineSeries, {
          color: line.color,
          lineWidth: (line.lineWidth || 2) as any,
          priceLineVisible: false,
          lastValueVisible: false,
        });
        overlaySeriesRef.current.set(line.id, series);
      }

      series.applyOptions({
        color: line.color,
        lineWidth: (line.lineWidth || 2) as any,
      });
      try {
        series.setData(normalized);
      } catch (error) {
        console.error(`[ChartComponent] Failed to set overlay line data for ${line.id}`, error);
        chart.removeSeries(series);
        overlaySeriesRef.current.delete(line.id);
      }
    }
  }, [overlayLines]);

  useEffect(() => {
    if (type !== 'candlestick') {
      return;
    }

    if (!markerPluginRef.current || typeof markerPluginRef.current.setMarkers !== 'function') {
      return;
    }

    const normalized = (Array.isArray(markers) ? markers : [])
      .map((marker) => {
        const normalizedTime = normalizeTime(marker?.time);
        if (normalizedTime === null) {
          return null;
        }

        return {
          time: normalizedTime as any,
          position: marker.position || 'inBar',
          shape: marker.shape || 'circle',
          color: marker.color,
          text: marker.text,
          id: marker.id,
        };
      })
      .filter((item): item is any => !!item)
      .sort((a, b) => Number(a.time) - Number(b.time));

    markerPluginRef.current.setMarkers(normalized);
  }, [markers, data.length, type]);

  const safeFixedHeight = Number.isFinite(Number(fixedHeight)) && Number(fixedHeight) > 40 ? Number(fixedHeight) : null;
  return <div ref={chartContainerRef} style={{ width: '100%', minHeight: safeFixedHeight || 260, height: safeFixedHeight || undefined, touchAction: 'none' }} />;
};

export default ChartComponent;