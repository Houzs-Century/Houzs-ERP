import type { CSSProperties } from 'react';
import styles from './Skeleton.module.css';

// ---------------------------------------------------------------------------
// Base — single shimmer rectangle. Width/height accept number (px) or string.
// ---------------------------------------------------------------------------

interface SkeletonProps {
  w?: number | string;
  h?: number | string;
  rounded?: boolean;
  className?: string;
  style?: CSSProperties;
}

const dim = (v: number | string | undefined): string | undefined =>
  v === undefined ? undefined : typeof v === 'number' ? `${v}px` : v;

export const Skeleton = ({ w, h, rounded = false, className, style }: SkeletonProps) => (
  <span
    className={`${styles.block} ${rounded ? styles.blockRounded : ''} ${className ?? ''}`}
    style={{ width: dim(w), height: dim(h), ...style }}
    aria-hidden="true"
  />
);

// ---------------------------------------------------------------------------
// Text lines — last line shortened for natural rhythm.
// ---------------------------------------------------------------------------

interface SkeletonTextProps {
  lines?: number;
  lineHeight?: number;
}

export const SkeletonText = ({ lines = 3, lineHeight = 12 }: SkeletonTextProps) => (
  <div className={styles.text}>
    {Array.from({ length: lines }).map((_, i) => (
      <Skeleton
        key={i}
        h={lineHeight}
        w={i === lines - 1 && lines > 1 ? '60%' : '100%'}
      />
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Card — title + body + button row
// ---------------------------------------------------------------------------

export const SkeletonCard = () => (
  <div className={styles.card}>
    <Skeleton h={16} w="45%" />
    <SkeletonText lines={3} />
    <div className={styles.cardBtnRow}>
      <Skeleton h={32} w={80} rounded />
      <Skeleton h={32} w={100} rounded />
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Table — header row + N data rows
// ---------------------------------------------------------------------------

interface SkeletonTableProps {
  rows?: number;
  cols?: number;
}

export const SkeletonTable = ({ rows = 5, cols = 4 }: SkeletonTableProps) => (
  <div className={styles.table}>
    <div className={styles.tableHeader}>
      {Array.from({ length: cols }).map((_, i) => (
        <div key={i} className={styles.cell}>
          <Skeleton h={10} w="70%" />
        </div>
      ))}
    </div>
    {Array.from({ length: rows }).map((_, r) => (
      <div key={r} className={styles.tableRow}>
        {Array.from({ length: cols }).map((_, c) => (
          <div key={c} className={styles.cell}>
            <Skeleton h={12} w={c === 0 ? '85%' : '95%'} />
          </div>
        ))}
      </div>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Table rows — <tr>/<td> based so they drop straight into a real <tbody>
// (e.g. DataGrid's loading state). `cols` should match the grid's column count.
// ---------------------------------------------------------------------------

export const SkeletonRows = ({ cols, rows = 10 }: { cols: number; rows?: number }) => (
  <>
    {Array.from({ length: rows }).map((_, r) => (
      <tr key={r} aria-hidden="true">
        {Array.from({ length: Math.max(cols, 1) }).map((_, c) => (
          <td key={c} style={{ padding: '6px 10px' }}>
            {/* Vary widths a little so it reads as data, not a flat grid. */}
            <Skeleton h={12} w={c === 0 ? 16 : `${55 + ((r * 7 + c * 13) % 40)}%`} />
          </td>
        ))}
      </tr>
    ))}
  </>
);

// ---------------------------------------------------------------------------
// Detail page — top bar + 2 cards. Used as Suspense fallback.
// ---------------------------------------------------------------------------

export const SkeletonDetailPage = () => (
  <div className={styles.page}>
    <div className={styles.pageHeader}>
      <div className={styles.pageHeaderTitles}>
        <Skeleton h={24} w={220} />
        <Skeleton h={12} w={160} />
      </div>
      <div className={styles.pageHeaderActions}>
        <Skeleton h={36} w={90} rounded />
        <Skeleton h={36} w={110} rounded />
      </div>
    </div>
    <SkeletonCard />
    <SkeletonCard />
  </div>
);
