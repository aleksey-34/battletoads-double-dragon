import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export type StrategyAccordionItem = {
  key: string;
  label: React.ReactNode;
  renderBody: () => React.ReactNode;
};

type Props = {
  items: StrategyAccordionItem[];
  activeKeys: string[];
  onToggleKey: (key: string) => void;
  containerMaxHeight?: string | number;
};

const COLLAPSED_H = 56;
const EXPANDED_H = 800;

const StrategyVirtualList: React.FC<Props> = ({
  items,
  activeKeys,
  onToggleKey,
  containerMaxHeight = '72dvh',
}) => {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      activeKeys.includes(items[index]?.key ?? '') ? EXPANDED_H : COLLAPSED_H,
    measureElement: (element) =>
      element?.getBoundingClientRect().height ?? COLLAPSED_H,
    overscan: 3,
  });

  if (items.length === 0) {
    return null;
  }

  return (
    <div
      ref={parentRef}
      style={{
        maxHeight: containerMaxHeight,
        overflowY: 'auto',
        WebkitOverflowScrolling: 'touch',
        border: '1px solid #d9d9d9',
        borderRadius: 8,
        background: '#fff',
      }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
          width: '100%',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = items[virtualRow.index];
          if (!item) return null;
          const isExpanded = activeKeys.includes(item.key);

          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                transform: `translateY(${virtualRow.start}px)`,
                width: '100%',
              }}
            >
              {/* Accordion header */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => onToggleKey(item.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onToggleKey(item.key);
                }}
                style={{
                  padding: '12px 16px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: isExpanded ? '#fafafa' : '#ffffff',
                  borderBottom: '1px solid #f0f0f0',
                  userSelect: 'none',
                  gap: 8,
                  minHeight: COLLAPSED_H,
                  boxSizing: 'border-box',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>{item.label}</div>
                <span style={{ fontSize: 10, color: '#aaa', flexShrink: 0 }}>
                  {isExpanded ? '▲' : '▼'}
                </span>
              </div>

              {/* Accordion body — only rendered when expanded */}
              {isExpanded && (
                <div
                  style={{
                    padding: 16,
                    borderBottom: '1px solid #f0f0f0',
                    background: '#fafafa',
                  }}
                >
                  {item.renderBody()}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default StrategyVirtualList;
