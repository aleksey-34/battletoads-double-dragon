import React from 'react';
import { Badge } from 'antd';

interface StatusIndicatorProps {
  status: string;
  message?: string;
}

const StatusIndicator: React.FC<StatusIndicatorProps> = ({ status, message }) => {
  const color = status === 'ok' ? 'green' : status === 'warning' ? 'yellow' : 'red';
  return <Badge color={color} title={message} />;
};

export default StatusIndicator;