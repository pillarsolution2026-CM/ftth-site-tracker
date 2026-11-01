import { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { ltr } from '@ftth/i18n';
import { POINT_FEATURE_TYPES, type FeatureType } from '@ftth/shared';
import {
  cadPalette,
  minTouchTarget,
  radius,
  spacing,
  typography,
  type CadMode,
} from '@ftth/ui-tokens';
import { useI18n } from '../../../shared/i18n/I18nProvider';
import { Button } from '../../../shared/ui/Button';
import { useTheme } from '../../../shared/ui/theme';
import type { Viewport } from '../../cad/model/viewport';
import { useAsBuiltEditor, type AsBuiltDeps } from '../hooks/useAsBuiltEditor';
import { useAsBuiltTouch } from '../hooks/useAsBuiltTouch';
import { ALLOWED_SYMBOL_TYPES, ASBUILT_TOOLS, type AsBuiltTool } from '../model/editor';
import { buildRenderModel } from '../model/render-model';
import { AsBuiltCanvas } from './AsBuiltCanvas';

interface Props {
  deps: AsBuiltDeps;
  viewport: Viewport | null;
  setViewport: (next: Viewport) => void;
  origin: { x: number; y: number };
  onLayout: (event: LayoutChangeEvent) => void;
  mode: CadMode;
  visible: ReadonlySet<FeatureType>;
  onExit: () => void;
}

/** Glyph per tool: the toolbar never relies on colour alone. */
const TOOL_GLYPH: Record<AsBuiltTool, string> = {
  move: '⇄',
  reshape: '⌇',
  draw: '⌒',
  symbol: '▣',
  label: 'T',
};

/** The CAD screen in As-Built mode: five tools, undo/redo, live length, save and cancel. */
export function AsBuiltMode({
  deps,
  viewport,
  setViewport,
  origin,
  onLayout,
  mode,
  visible,
  onExit,
}: Props) {
  const { t } = useI18n();
  const theme = useTheme();
  const editor = useAsBuiltEditor(deps);
  const touch = useAsBuiltTouch(editor.handlers, viewport, setViewport, origin);
  const { ui, ctx } = editor;
  const model = useMemo(() => (ctx ? buildRenderModel(ctx, ui) : null), [ctx, ui]);
  const palette = cadPalette[mode];
  const selected = model?.features.find((f) => f.id === ui.selectedId) ?? null;
  const [labelText, setLabelText] = useState('');
  useEffect(() => setLabelText(selected?.text ?? ''), [selected?.id]);

  const errorKey = editor.saveError ?? ui.error;
  const lengthM = editor.lengthM;

  const cancel = () => {
    editor.handlers.reset();
    onExit();
  };

  return (
    <>
      <View style={[styles.tools, { backgroundColor: theme.background }]} testID="asbuilt-toolbar">
        <ScrollView horizontal contentContainerStyle={styles.toolsRow}>
          {ASBUILT_TOOLS.map((tool) => {
            const active = ui.tool === tool;
            return (
              <Pressable
                key={tool}
                testID={`tool-${tool}`}
                accessibilityRole="button"
                accessibilityLabel={t(`asbuilt.tools.${tool}`)}
                accessibilityState={{ selected: active }}
                onPress={() => editor.handlers.setTool(tool)}
                style={[
                  styles.tool,
                  {
                    borderColor: theme.text,
                    backgroundColor: active ? palette.asbuilt : 'transparent',
                  },
                ]}
              >
                <Text
                  style={{ color: active ? palette.background : theme.text, fontWeight: '700' }}
                >
                  {TOOL_GLYPH[tool]} {t(`asbuilt.tools.${tool}`)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>
      <View style={styles.canvas} onLayout={onLayout} testID="cad-area" {...touch}>
        {viewport && model ? (
          <AsBuiltCanvas model={model} viewport={viewport} mode={mode} visible={visible} />
        ) : null}
      </View>
      <ScrollView
        style={[styles.panel, { backgroundColor: theme.background }]}
        contentContainerStyle={styles.panelBody}
      >
        <Text style={{ color: theme.text }}>{t(`asbuilt.hints.${ui.tool}`)}</Text>
        <View style={styles.legend}>
          <Text style={{ color: theme.text }}>
            {'┄'} {t('asbuilt.legend.design')}
          </Text>
          <Text style={{ color: palette.asbuilt }}>
            {'●'} {t('asbuilt.legend.approved')}
          </Text>
          <Text style={{ color: palette.asbuiltPending }}>
            {'⏳'} {t('asbuilt.legend.pending')}
          </Text>
        </View>
        {lengthM !== null ? (
          <Text style={[styles.length, { color: theme.text }]} testID="asbuilt-length">
            {t('asbuilt.length', { length: ltr(lengthM.toFixed(2)) })}
          </Text>
        ) : null}
        <Text style={{ color: theme.text }} testID="asbuilt-selected">
          {selected
            ? t('asbuilt.selected', {
                name: `${t(`featureType.${selected.type}`)} ${selected.text ? ltr(selected.text) : ''}`,
              })
            : t('asbuilt.nothingSelected')}
        </Text>

        {ui.tool === 'reshape' ? (
          <Button
            variant="secondary"
            label={t('asbuilt.deleteVertex')}
            disabled={ui.selectedVertex === null}
            onPress={editor.handlers.deleteVertex}
            testID="delete-vertex"
          />
        ) : null}
        {ui.tool === 'draw' ? (
          <Button
            variant="secondary"
            label={`${t('asbuilt.finish')} (${t('asbuilt.vertices', { count: ltr(ui.session.draft.length) })})`}
            disabled={!editor.canFinish}
            onPress={editor.handlers.finish}
            testID="finish-route"
          />
        ) : null}
        {ui.tool === 'symbol' ? (
          <View accessibilityLabel={t('asbuilt.chooseSymbol')} style={styles.row}>
            {POINT_FEATURE_TYPES.filter((type) =>
              (ALLOWED_SYMBOL_TYPES as readonly string[]).includes(type),
            ).map((type) => (
              <Pressable
                key={type}
                testID={`symbol-${type}`}
                accessibilityRole="button"
                accessibilityState={{ selected: ui.symbolType === type }}
                onPress={() => editor.handlers.chooseSymbol(type)}
                style={[
                  styles.tool,
                  {
                    borderColor: theme.text,
                    backgroundColor: ui.symbolType === type ? palette.asbuilt : 'transparent',
                  },
                ]}
              >
                <Text
                  style={{
                    color: ui.symbolType === type ? palette.background : theme.text,
                    fontWeight: '600',
                  }}
                >
                  {t(`featureType.${type}`)}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {ui.tool === 'label' ? (
          <View style={styles.row}>
            <TextInput
              testID="label-input"
              accessibilityLabel={t('asbuilt.labelInput')}
              value={labelText}
              onChangeText={setLabelText}
              editable={selected !== null}
              style={[styles.input, { color: theme.text, borderColor: theme.border }]}
            />
            <Button
              variant="secondary"
              label={t('asbuilt.applyLabel')}
              disabled={selected === null}
              onPress={() => editor.handlers.applyLabel(labelText)}
              testID="apply-label"
            />
          </View>
        ) : null}

        {editor.stale.length > 0 ? (
          <Text accessibilityRole="alert" style={{ color: theme.danger }} testID="asbuilt-stale">
            {'⚠'} {t('asbuilt.errors.STALE_BASE')}
          </Text>
        ) : null}
        {errorKey ? (
          <Text accessibilityRole="alert" style={{ color: theme.danger }} testID="asbuilt-error">
            {'⚠'} {t(`asbuilt.errors.${errorKey}` as 'asbuilt.errors.INVALID_OP')}
          </Text>
        ) : null}
        {editor.savedCount > 0 ? (
          <Text style={{ color: theme.text }} testID="asbuilt-saved">
            {'✓'} {t('asbuilt.saved')}
          </Text>
        ) : null}

        <TextInput
          testID="asbuilt-note"
          accessibilityLabel={t('asbuilt.note')}
          placeholder={t('asbuilt.note')}
          placeholderTextColor={theme.border}
          value={editor.note}
          onChangeText={editor.setNote}
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />
        <View style={styles.row}>
          <Button
            variant="secondary"
            label={t('asbuilt.undo')}
            disabled={!editor.canUndo}
            onPress={editor.handlers.undo}
            testID="asbuilt-undo"
          />
          <Button
            variant="secondary"
            label={t('asbuilt.redo')}
            disabled={!editor.canRedo}
            onPress={editor.handlers.redo}
            testID="asbuilt-redo"
          />
        </View>
        <View style={styles.row}>
          <Button
            label={t('asbuilt.save')}
            busy={editor.saving}
            disabled={!editor.canSave}
            onPress={() => void editor.save()}
            testID="asbuilt-save"
          />
          <Button
            variant="secondary"
            label={t('asbuilt.cancel')}
            onPress={cancel}
            testID="asbuilt-cancel"
          />
        </View>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  tools: { paddingVertical: spacing.xs },
  toolsRow: { gap: spacing.sm, paddingHorizontal: spacing.sm },
  tool: {
    minHeight: minTouchTarget,
    minWidth: minTouchTarget,
    paddingHorizontal: spacing.md,
    borderWidth: 2,
    borderRadius: radius.md,
    justifyContent: 'center',
  },
  canvas: { flex: 1, overflow: 'hidden' },
  panel: { maxHeight: 280 },
  panelBody: { padding: spacing.md, gap: spacing.sm },
  legend: { gap: spacing.xs },
  length: {
    fontSize: typography.size.lg,
    fontWeight: '700',
    writingDirection: 'ltr',
  },
  row: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', alignItems: 'center' },
  input: {
    flex: 1,
    minHeight: minTouchTarget,
    borderWidth: 2,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    fontSize: typography.size.md,
  },
});
