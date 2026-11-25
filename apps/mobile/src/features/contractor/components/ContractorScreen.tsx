import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { minTouchTarget, radius, spacing, statusTokens, typography } from '@ftth/ui-tokens';
import type {
  ContractorPortalResponse,
  PortalRegistration,
  PortalWork,
  UpdateStatus,
} from '@ftth/shared';
import { ApiError } from '../../auth/api/api-client';
import { useAuth } from '../../auth/hooks/AuthProvider';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { Button } from '../../../shared/ui/Button';
import { LanguageSwitcher } from '../../../shared/ui/LanguageSwitcher';
import { useTheme } from '../../../shared/ui/theme';
import type { PortalCache } from '../model/portal-cache';
import { currentPrice, formatStamp, STATUS_FILTERS, visibleWork } from '../model/portal-view';
import type { StatusFilter } from '../model/portal-view';

export interface PortalSource {
  contractorPortal(): Promise<ContractorPortalResponse>;
}

const PAGE = 30;

const STATUS_COLOR: Record<UpdateStatus, string> = {
  pending: statusTokens.inProgress.color,
  approved: statusTokens.approved.color,
  rejected: statusTokens.rejected.color,
};

/** Numbers, codes, dates and money always read left to right, also inside Arabic text. */
function Ltr({ children, style }: { children: ReactNode; style?: object }) {
  return <Text style={[{ writingDirection: 'ltr' }, style]}>{children}</Text>;
}

/**
 * The contractor's read-only screen (ADR-053): totals, his lines and the recorded work, from
 * GET /contractor/me. The last answer is kept sealed on the phone and shown when offline.
 */
export function ContractorScreen({ api, cache }: { api: PortalSource; cache: PortalCache }) {
  const { t } = useI18n();
  const theme = useTheme();
  const { me, logout } = useAuth();
  const [portal, setPortal] = useState<ContractorPortalResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [shown, setShown] = useState<Record<string, number>>({});
  const hasPortal = useRef(false);

  const load = useCallback(async () => {
    if (!me?.contractor) return;
    setRefreshing(true);
    try {
      const fresh = await api.contractorPortal();
      hasPortal.current = true;
      setPortal(fresh);
      setOffline(false);
      setFailed(false);
      await cache.write({ me, portal: fresh }).catch(() => undefined);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
        // The server no longer lets this account in: nothing stays readable on the phone.
        await cache.clear().catch(() => undefined);
        await logout();
        return;
      }
      if (!hasPortal.current) {
        const saved = await cache.read();
        if (saved && saved.portal.contractor.id === me.contractor.id) {
          hasPortal.current = true;
          setPortal(saved.portal);
        }
      }
      if (hasPortal.current) setOffline(true);
      else setFailed(true);
    } finally {
      setRefreshing(false);
    }
  }, [api, cache, me, logout]);

  useEffect(() => {
    void load();
    // Load once per signed-in profile; pull-to-refresh calls `load` again.
  }, [me?.id]);

  return (
    <ScrollView
      style={{ backgroundColor: theme.background }}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void load()}
          testID="portal-refresh"
        />
      }
    >
      <Text style={[styles.title, { color: theme.text }]} testID="portal-name">
        {portal?.contractor.name ?? me?.contractor?.name ?? ''}
      </Text>
      <Text style={{ color: theme.text }}>{t('mobileContractor.readOnly')}</Text>

      {portal ? (
        <Text style={{ color: theme.text }} testID="portal-updated">
          {t('mobileContractor.lastUpdated', { time: formatStamp(portal.serverTime) })}
        </Text>
      ) : null}
      {offline ? (
        <Text
          style={[styles.notice, { color: theme.text, borderColor: theme.border }]}
          testID="portal-offline"
        >
          {t('mobileContractor.offline')}
        </Text>
      ) : null}

      {!portal && failed ? (
        <View style={styles.block}>
          <Text style={{ color: theme.danger }} testID="portal-failed">
            {t('mobileContractor.loadFailed')} {t('mobileContractor.noData')}
          </Text>
          <Button
            variant="secondary"
            label={t('mobileContractor.retry')}
            onPress={() => void load()}
            testID="portal-retry"
          />
        </View>
      ) : null}

      {portal ? (
        <>
          <Text style={[styles.section, { color: theme.text }]}>
            {t('mobileContractor.totals')}
          </Text>
          {portal.totals.map((totals) => (
            <View
              key={totals.currency}
              style={[styles.card, { borderColor: theme.border }]}
              testID={`totals-${totals.currency}`}
            >
              {(['approved', 'pending', 'rejected'] as const).map((status) => (
                <View key={status} style={styles.row}>
                  <Text style={{ color: STATUS_COLOR[status], fontWeight: '700' }}>
                    {t(`mobileContractor.${status}`)}
                  </Text>
                  <Ltr style={{ color: theme.text, fontWeight: '700' }}>
                    {`${totals[status]} ${totals.currency}`}
                  </Ltr>
                </View>
              ))}
            </View>
          ))}

          <Text style={[styles.section, { color: theme.text }]}>
            {t('mobileContractor.filter')}
          </Text>
          <View style={styles.chips}>
            {STATUS_FILTERS.map((option) => {
              const active = option === filter;
              return (
                <Pressable
                  key={option}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  onPress={() => setFilter(option)}
                  style={[
                    styles.chip,
                    {
                      borderColor: active ? theme.brand : theme.border,
                      backgroundColor: active ? theme.brand : 'transparent',
                    },
                  ]}
                  testID={`filter-${option}`}
                >
                  <Text style={{ color: active ? theme.brandContrast : theme.text }}>
                    {option === 'all'
                      ? t('mobileContractor.filterAll')
                      : t(`mobileContractor.${option}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {portal.registrations.length === 0 ? (
            <Text style={{ color: theme.text }}>{t('mobileContractor.noRegistrations')}</Text>
          ) : null}
          {portal.registrations.map((registration) => (
            <RegistrationView
              key={registration.registrationId}
              registration={registration}
              work={visibleWork(
                portal.work.filter((item) => item.registrationId === registration.registrationId),
                filter,
              )}
              limit={shown[registration.registrationId] ?? PAGE}
              onMore={() =>
                setShown((prev) => ({
                  ...prev,
                  [registration.registrationId]: (prev[registration.registrationId] ?? PAGE) + PAGE,
                }))
              }
            />
          ))}
        </>
      ) : null}

      <LanguageSwitcher />
      <Button
        variant="secondary"
        label={t('common.logout')}
        onPress={() => void logout()}
        testID="portal-logout"
      />
    </ScrollView>
  );
}

function RegistrationView({
  registration,
  work,
  limit,
  onMore,
}: {
  registration: PortalRegistration;
  work: PortalWork[];
  limit: number;
  onMore: () => void;
}) {
  const { t } = useI18n();
  const theme = useTheme();
  const lineById = new Map(registration.lines.map((line) => [line.contractorLineId, line]));
  return (
    <View style={styles.block} testID={`registration-${registration.registrationId}`}>
      <Text style={[styles.section, { color: theme.text }]}>
        {t('mobileContractor.registration', {
          project: registration.projectName,
          number: registration.workOrderNumber,
        })}
      </Text>

      <Text style={[styles.subsection, { color: theme.text }]}>
        {t('mobileContractor.myLines')}
      </Text>
      {registration.lines.length === 0 ? (
        <Text style={{ color: theme.text }}>{t('mobileContractor.noLines')}</Text>
      ) : null}
      {registration.lines.map((line) => (
        <View
          key={line.contractorLineId}
          style={[styles.card, { borderColor: theme.border }]}
          testID={`line-${line.contractorLineId}`}
        >
          <Text style={{ color: theme.text, fontWeight: '700' }}>
            <Ltr>{line.code}</Ltr> {line.description}
          </Text>
          <Text style={{ color: theme.text }}>
            {t('mobileContractor.unit')}: <Ltr>{line.unit}</Ltr>
          </Text>
          <Text style={{ color: theme.text }}>
            {t('mobileContractor.scope')}: {line.scope ?? t('mobileContractor.wholeLine')}
          </Text>
          <View style={styles.row}>
            <Text style={{ color: theme.text }}>{t('mobileContractor.quantity')}</Text>
            <Ltr style={{ color: theme.text }}>{line.quantity}</Ltr>
          </View>
          <View style={styles.row}>
            <Text style={{ color: theme.text }}>{t('mobileContractor.recorded')}</Text>
            <Ltr style={{ color: theme.text }}>{line.recordedQuantity}</Ltr>
          </View>
          <View style={styles.row}>
            <Text style={{ color: theme.text }}>{t('mobileContractor.price')}</Text>
            <Ltr style={{ color: theme.text }}>
              {`${currentPrice(line)} ${registration.currency}`}
            </Ltr>
          </View>
        </View>
      ))}

      <Text style={[styles.subsection, { color: theme.text }]}>{t('mobileContractor.work')}</Text>
      {work.length === 0 ? (
        <Text style={{ color: theme.text }}>{t('mobileContractor.noWork')}</Text>
      ) : null}
      {work.slice(0, limit).map((item) => {
        const line = lineById.get(item.contractorLineId);
        return (
          <View
            key={item.key}
            style={[styles.card, { borderColor: theme.border }]}
            testID={`work-${item.key}`}
          >
            <View style={styles.row}>
              <Ltr style={{ color: theme.text }}>{item.workDate}</Ltr>
              <Text style={{ color: STATUS_COLOR[item.status], fontWeight: '700' }}>
                {t(`mobileContractor.${item.status}`)}
              </Text>
            </View>
            <Text style={{ color: theme.text }}>
              {item.element === null
                ? t('qc.planning')
                : t(`featureType.${item.element.featureType}`)}
              {item.element?.code ? <Ltr>{` ${item.element.code}`}</Ltr> : null}
              {line ? <Ltr>{`  ${line.code}`}</Ltr> : null}
            </Text>
            <View style={styles.row}>
              <Text style={{ color: theme.text }}>{t('mobileContractor.quantity')}</Text>
              <Ltr style={{ color: theme.text }}>{item.quantity}</Ltr>
            </View>
            <View style={styles.row}>
              <Text style={{ color: theme.text }}>{t('mobileContractor.unitPrice')}</Text>
              <Ltr
                style={{ color: theme.text }}
              >{`${item.unitPrice} ${registration.currency}`}</Ltr>
            </View>
            <View style={styles.row}>
              <Text style={{ color: theme.text, fontWeight: '700' }}>
                {t('mobileContractor.value')}
              </Text>
              <Ltr style={{ color: theme.text, fontWeight: '700' }}>
                {`${item.value} ${registration.currency}`}
              </Ltr>
            </View>
            {item.reviewReason ? (
              <Text style={{ color: theme.danger }}>
                {t('mobileContractor.reason', { reason: item.reviewReason })}
              </Text>
            ) : null}
          </View>
        );
      })}
      {work.length > limit ? (
        <Button
          variant="secondary"
          label={t('mobileContractor.showMore')}
          onPress={onMore}
          testID={`more-${registration.registrationId}`}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.xl, gap: spacing.lg },
  title: { fontSize: typography.size.xl, fontWeight: '700' },
  section: { fontSize: typography.size.lg, fontWeight: '700' },
  subsection: { fontSize: typography.size.md, fontWeight: '600' },
  block: { gap: spacing.md },
  notice: { borderWidth: 1, borderRadius: radius.md, padding: spacing.md },
  card: { borderWidth: 2, borderRadius: radius.md, padding: spacing.lg, gap: spacing.xs },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    borderWidth: 2,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
