import React, { useState } from 'react';
import axios from 'axios';
import { Form, Input, Button, Alert, Typography, message, Modal, Space } from 'antd';
import { useI18n } from '../i18n';

type LoginFormValues = {
  password: string;
};

type RecoveryFormValues = {
  code: string;
  newPassword: string;
  confirmPassword: string;
};

type RecoveryStatus = {
  enabled: boolean;
  transport: 'telegram' | 'disabled';
  targetMasked: string;
  codeTtlMin: number;
  cooldownSec: number;
  message?: string;
};

const Login: React.FC = () => {
  const { t } = useI18n();
  const [loginForm] = Form.useForm<LoginFormValues>();
  const [recoveryForm] = Form.useForm<RecoveryFormValues>();
  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState<string>('');
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [recoveryStatus, setRecoveryStatus] = useState<RecoveryStatus | null>(null);
  const [recoveryStatusLoading, setRecoveryStatusLoading] = useState(false);
  const [recoveryActionLoading, setRecoveryActionLoading] = useState(false);
  const [recoveryErrorText, setRecoveryErrorText] = useState('');

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

  const openRecoveryModal = async () => {
    setRecoveryOpen(true);
    setRecoveryStatusLoading(true);
    setRecoveryErrorText('');

    try {
      const response = await axios.get<RecoveryStatus>('/api/auth/recovery/status');
      setRecoveryStatus(response.data);
    } catch (error: any) {
      setRecoveryErrorText(String(error?.response?.data?.error || error?.message || t('login.recoveryStatusLoadError', 'Failed to load recovery status')));
    } finally {
      setRecoveryStatusLoading(false);
    }
  };

  const requestRecoveryCode = async () => {
    setRecoveryActionLoading(true);
    setRecoveryErrorText('');

    try {
      await axios.post('/api/auth/recovery/request');
      message.success(t('login.recoveryCodeSent', 'Recovery code sent. Check your recovery channel.'));
    } catch (error: any) {
      setRecoveryErrorText(String(error?.response?.data?.error || error?.message || t('login.recoveryRequestError', 'Failed to send recovery code')));
    } finally {
      setRecoveryActionLoading(false);
    }
  };

  const submitRecoveryReset = async () => {
    setRecoveryErrorText('');

    try {
      const values = await recoveryForm.validateFields();
      if (values.newPassword !== values.confirmPassword) {
        setRecoveryErrorText(t('login.recoveryConfirmMismatch', 'Password confirmation does not match'));
        return;
      }

      setRecoveryActionLoading(true);
      await axios.post('/api/auth/recovery/reset', {
        code: values.code,
        newPassword: values.newPassword,
      });

      loginForm.setFieldsValue({ password: values.newPassword });
      recoveryForm.resetFields();
      setRecoveryOpen(false);
      message.success(t('login.recoveryResetSuccess', 'Password has been reset. Use new password to login.'));
    } catch (error: any) {
      if (!error?.response && error?.errorFields) {
        return;
      }
      setRecoveryErrorText(String(error?.response?.data?.error || error?.message || t('login.recoveryResetError', 'Failed to reset password')));
    } finally {
      setRecoveryActionLoading(false);
    }
  };

  return (
    <div className="battletoads-form-shell" style={{ maxWidth: 420, margin: '40px auto' }}>
      <Typography.Title level={4} style={{ marginBottom: 8 }}>{t('login.title', 'Dashboard Login')}</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 14 }}>
        {t('login.subtitle', 'Enter VPS dashboard password. It will be verified with backend before login.')}
      </Typography.Paragraph>

      {errorText ? <Alert type="error" message={errorText} style={{ marginBottom: 12 }} /> : null}

      <Form className="battletoads-form" form={loginForm} onFinish={onFinish}>
        <Form.Item name="password" rules={[{ required: true, message: t('login.passwordRequired', 'Please input password') }]}>
          <Input.Password placeholder={t('login.passwordPlaceholder', 'Password')} autoFocus />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            {t('login.submit', 'Login')}
          </Button>
        </Form.Item>
        <Form.Item style={{ marginTop: -4, marginBottom: 0 }}>
          <Button type="link" onClick={() => void openRecoveryModal()} style={{ padding: 0 }}>
            {t('login.forgot', 'Forgot password?')}
          </Button>
        </Form.Item>
      </Form>

      <Space direction="vertical" size={4} style={{ marginTop: 10 }}>
        <Typography.Text type="secondary">
          {t('login.clientHint', 'Client user? Use the self-registration portal.')}
        </Typography.Text>
        <Space wrap>
          <Button size="small" href="/client/login">{t('login.clientLogin', 'Client login')}</Button>
          <Button size="small" type="dashed" href="/client/register">{t('login.clientRegister', 'Client register')}</Button>
        </Space>
      </Space>

      <Modal
        title={t('login.recoveryTitle', 'Password recovery')}
        open={recoveryOpen}
        onCancel={() => {
          setRecoveryOpen(false);
          setRecoveryErrorText('');
        }}
        footer={null}
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 10 }}>
          {t('login.recoverySubtitle', 'Request a one-time code and set a new dashboard password.')}
        </Typography.Paragraph>

        {recoveryErrorText ? <Alert style={{ marginBottom: 10 }} type="error" message={recoveryErrorText} /> : null}

        {recoveryStatusLoading ? (
          <Typography.Paragraph type="secondary">{t('login.recoveryStatusLoading', 'Loading recovery status...')}</Typography.Paragraph>
        ) : null}

        {recoveryStatus && !recoveryStatus.enabled ? (
          <Alert
            style={{ marginBottom: 10 }}
            type="warning"
            message={recoveryStatus.message || t('login.recoveryUnavailable', 'Recovery is not configured on server')}
          />
        ) : null}

        {recoveryStatus?.enabled ? (
          <>
            <Space direction="vertical" size={2} style={{ marginBottom: 12 }}>
              <Typography.Text type="secondary">
                {t('login.recoveryChannel', 'Recovery channel')}: {recoveryStatus.transport} {recoveryStatus.targetMasked || ''}
              </Typography.Text>
              <Typography.Text type="secondary">
                {t('login.recoveryCodeTtl', 'Code TTL')}: {recoveryStatus.codeTtlMin} min
              </Typography.Text>
            </Space>

            <Button onClick={() => void requestRecoveryCode()} loading={recoveryActionLoading} block style={{ marginBottom: 12 }}>
              {t('login.recoverySendCode', 'Send recovery code')}
            </Button>
          </>
        ) : null}

        <Form form={recoveryForm} layout="vertical" onFinish={() => void submitRecoveryReset()}>
          <Form.Item
            name="code"
            label={t('login.recoveryCodeLabel', 'Recovery code')}
            rules={[{ required: true, message: t('login.recoveryCodeRequired', 'Enter recovery code') }]}
          >
            <Input placeholder={t('login.recoveryCodePlaceholder', '6-digit code')} />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label={t('login.recoveryNewPasswordLabel', 'New password')}
            rules={[
              { required: true, message: t('login.recoveryPasswordRequired', 'Enter new password') },
              { min: 12, message: t('login.recoveryPasswordMin', 'Password must be at least 12 characters') },
            ]}
          >
            <Input.Password placeholder={t('login.recoveryNewPasswordPlaceholder', 'New password (12+ chars)')} />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label={t('login.recoveryConfirmPasswordLabel', 'Confirm new password')}
            rules={[{ required: true, message: t('login.recoveryConfirmRequired', 'Confirm new password') }]}
          >
            <Input.Password placeholder={t('login.recoveryConfirmPasswordPlaceholder', 'Confirm password')} />
          </Form.Item>

          <Form.Item style={{ marginBottom: 0 }}>
            <Button type="primary" htmlType="submit" loading={recoveryActionLoading} block>
              {t('login.recoveryReset', 'Reset password')}
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
};

export default Login;