import React, { useState } from 'react';
import axios from 'axios';
import { Form, Input, Button, Alert, Typography, message } from 'antd';
import { useI18n } from '../i18n';

type LoginFormValues = {
  password: string;
};

const Login: React.FC = () => {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string>('');

  const onFinish = async (values: LoginFormValues) => {
    setLoading(true);
    setErrorText('');

    try {
      await axios.get('/api/api-keys', {
        headers: {
          Authorization: `Bearer ${values.password}`,
        },
      });

      localStorage.setItem('password', values.password);
      axios.defaults.headers.common.Authorization = `Bearer ${values.password}`;
      window.dispatchEvent(new Event('auth-changed'));
      message.success(t('login.loggedIn', 'Logged in'));
      window.location.href = '/';
    } catch (error: any) {
      const status = Number(error?.response?.status || 0);
      if (status === 401) {
        setErrorText(t('login.invalidPassword', 'Invalid password. Please check VPS password and try again.'));
      } else {
        setErrorText(t('login.backendUnavailable', 'Backend is unavailable. Check backend service and network.'));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="battletoads-form-shell" style={{ maxWidth: 420, margin: '40px auto' }}>
      <Typography.Title level={4} style={{ marginBottom: 8 }}>{t('login.title', 'Dashboard Login')}</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 14 }}>
        {t('login.subtitle', 'Enter VPS dashboard password. It will be verified with backend before login.')}
      </Typography.Paragraph>

      {errorText ? <Alert type="error" message={errorText} style={{ marginBottom: 12 }} /> : null}

      <Form className="battletoads-form" onFinish={onFinish}>
        <Form.Item name="password" rules={[{ required: true, message: t('login.passwordRequired', 'Please input password') }]}>
          <Input.Password placeholder={t('login.passwordPlaceholder', 'Password')} autoFocus />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            {t('login.submit', 'Login')}
          </Button>
        </Form.Item>
      </Form>
    </div>
  );
};

export default Login;