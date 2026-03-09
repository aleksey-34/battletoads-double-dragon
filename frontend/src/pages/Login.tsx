import React, { useState } from 'react';
import { Form, Input, Button, message } from 'antd';

const Login: React.FC = () => {
  const [loading, setLoading] = useState(false);

  const onFinish = (values: any) => {
    setLoading(true);
    // Для простоты, сохраняем пароль в localStorage
    localStorage.setItem('password', values.password);
    message.success('Logged in');
    setLoading(false);
    window.location.href = '/';
  };

  return (
    <Form onFinish={onFinish} style={{ maxWidth: 300, margin: 'auto' }}>
      <Form.Item name="password" rules={[{ required: true, message: 'Please input password!' }]}>
        <Input.Password placeholder="Password" />
      </Form.Item>
      <Form.Item>
        <Button type="primary" htmlType="submit" loading={loading}>Login</Button>
      </Form.Item>
    </Form>
  );
};

export default Login;