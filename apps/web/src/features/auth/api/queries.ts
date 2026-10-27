import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LoginRequest } from '@ftth/shared';
import { fetchMe, login, logout } from './session-client';

export const meQueryKey = ['session', 'me'] as const;

export function useMeQuery() {
  return useQuery({ queryKey: meQueryKey, queryFn: fetchMe, retry: false });
}

export function useLoginMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => login(body),
    onSuccess: () => client.invalidateQueries({ queryKey: meQueryKey }),
  });
}

export function useLogoutMutation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: logout,
    onSettled: () => client.removeQueries({ queryKey: meQueryKey }),
  });
}
