import { useState } from 'react';
import { useRouter } from 'expo-router';
import type { MessageKey } from '@ftth/i18n';
import { errorKeyOf, validateLogin, type LoginFieldErrors } from '../model/login-form';
import { useAuth } from './AuthProvider';

export function useLoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});
  const [submitError, setSubmitError] = useState<MessageKey | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (submitting) return;
    setSubmitError(null);
    const result = validateLogin(email, password);
    if (!result.ok) {
      setFieldErrors(result.errors);
      return;
    }
    setFieldErrors({});
    setSubmitting(true);
    try {
      await login(result.value);
      router.replace('/');
    } catch (error) {
      setSubmitError(errorKeyOf(error));
    } finally {
      setSubmitting(false);
    }
  }

  return {
    email,
    password,
    setEmail,
    setPassword,
    fieldErrors,
    submitError,
    submitting,
    submit,
  };
}
