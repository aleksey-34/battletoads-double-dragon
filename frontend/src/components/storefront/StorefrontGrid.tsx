import React from 'react';

type StorefrontGridProps = {
  children: React.ReactNode;
  className?: string;
};

const StorefrontGrid: React.FC<StorefrontGridProps> = ({ children, className }) => (
  <div className={['storefront-grid', className].filter(Boolean).join(' ')}>
    {children}
  </div>
);

export default StorefrontGrid;
