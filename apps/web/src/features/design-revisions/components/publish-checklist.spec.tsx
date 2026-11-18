import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  BoxTypesReport,
  InstallationIssue,
  InstallationReport,
  PublishCheckKey,
  PublishReadiness,
} from '@ftth/shared';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test-utils/render';
import { PublishChecklist } from './publish-checklist';
import { RevisionStatusBadge } from './revision-status-badge';

/**
 * ADR-049 part B moved the installation and box-types reports from the checklist to its drawings.
 * These fixtures keep naming them at the top level; `toReadiness` puts them on a drawing.
 */
type LegacyReadiness = PublishReadiness & {
  installation?: InstallationReport | null;
  boxTypes?: BoxTypesReport | null;
};
function toReadiness(data: LegacyReadiness): PublishReadiness {
  const { installation = null, boxTypes = null, ...rest } = data;
  if (!installation && !boxTypes) return rest;
  return {
    ...rest,
    drawings: [
      {
        drawingId: '11111111-1111-4111-8111-111111111111',
        drawingKind: rest.drawingKind ?? 'general',
        ordinal: 1,
        draftRevisionId: null,
        state: 'draft',
        checks: [],
        warningCount: 0,
        installation,
        boxTypes,
      },
    ],
  };
}

function readiness(
  failing: PublishCheckKey[] = [],
  counts: Partial<Record<PublishCheckKey, number | null>> = {},
): LegacyReadiness {
  const base: Record<PublishCheckKey, number | null> = {
    crs_known: null,
    control_point: 2,
    no_problems: 0,
    open_items: 0,
    site_drawings: 0,
    cabinets_match: 0,
    cabinets_other_site: 0,
    installation: 0,
    box_types: null,
    ...counts,
  };
  const keys = [
    'crs_known',
    'control_point',
    'no_problems',
    'open_items',
    'site_drawings',
    'cabinets_match',
    'cabinets_other_site',
    'installation',
    'box_types',
  ] as const;
  return {
    checks: keys.map((key) => ({ key, ok: !failing.includes(key), count: base[key] })),
    canPublish: !failing.some((key) => key !== 'open_items'),
    siteId: null,
    revisionId: null,
    drawingKind: 'general',
    siteRevisionIds: [],
    drawings: [],
    cabinetsInOtherSites: [],
    needsAcknowledgement: failing.includes('open_items'),
    cabinets: null,
    warningCount: 0,
    switchedOff: [],
  };
}

function setup(
  input: LegacyReadiness | null,
  props: Partial<Parameters<typeof PublishChecklist>[0]> = {},
) {
  const data = input ? toReadiness(input) : null;
  const onPublish = vi.fn();
  const onAcknowledgedChange = vi.fn();
  renderScreen(
    <PublishChecklist
      readiness={data}
      loading={false}
      failed={false}
      acknowledged={false}
      publishing={false}
      allowed={data?.canPublish === true && !data.needsAcknowledgement}
      mappingHref="/en/projects/p/cad-files/f/mapping"
      revisionHref={() => null}
      onAcknowledgedChange={onAcknowledgedChange}
      onPublish={onPublish}
      {...props}
    />,
  );
  return { onPublish, onAcknowledgedChange };
}

describe('PublishChecklist', () => {
  it('lists the seven checks with an icon and a word each, with counts', () => {
    setup(readiness(['no_problems'], { no_problems: 5 }));
    expect(screen.getByText('Coordinates: source CRS chosen')).toBeInTheDocument();
    expect(screen.getByText(/At least one control point in use \(.*2.*\)/)).toBeInTheDocument();
    expect(screen.getByText(/No drawing errors \(.*5.* left\)/)).toBeInTheDocument();
    expect(screen.getByText(/Open items reviewed/)).toBeInTheDocument();
    expect(screen.getByText(/Every drawing of the site is ready/)).toBeInTheDocument();
    expect(screen.getByText('Installation method (pull / trench) is clear')).toBeInTheDocument();
    expect(screen.getAllByText('✅')).toHaveLength(8);
    expect(screen.getByText('❌')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getAllByText('(Done)')).toHaveLength(8);
    expect(screen.getByText('(Not done)')).toBeInTheDocument();
  });

  it.each([
    'crs_known',
    'control_point',
    'no_problems',
    'site_drawings',
    'cabinets_match',
  ] as const)('locks Publish when %s fails', (key) => {
    setup(readiness([key]));
    expect(screen.getByRole('button', { name: 'Publish the site' })).toBeDisabled();
    expect(screen.getByText(/locked until all checks except open items/)).toBeInTheDocument();
  });

  it('enables Publish when every check is ok and publishes on click', async () => {
    const user = userEvent.setup();
    const { onPublish } = setup(readiness());
    const button = screen.getByRole('button', { name: 'Publish the site' });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(onPublish).toHaveBeenCalled();
  });

  it('still needs the acknowledgement for open items', async () => {
    const user = userEvent.setup();
    const { onAcknowledgedChange } = setup(readiness(['open_items'], { open_items: 4 }));
    expect(screen.getByRole('button', { name: 'Publish the site' })).toBeDisabled();
    await user.click(screen.getByLabelText(/I understand/));
    expect(onAcknowledgedChange).toHaveBeenCalledWith(true);
  });

  it('enables Publish once the open items are acknowledged', () => {
    setup(readiness(['open_items'], { open_items: 4 }), { acknowledged: true, allowed: true });
    expect(screen.getByRole('button', { name: 'Publish the site' })).toBeEnabled();
  });

  it('links failed coordinate checks to the mapping screen, but no other check', () => {
    setup(readiness(['crs_known', 'no_problems']));
    const links = screen.getAllByRole('link', { name: 'Open the coordinates screen' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/en/projects/p/cad-files/f/mapping');
  });

  it('keeps Publish disabled while readiness is loading', () => {
    setup(null, { loading: true, allowed: false });
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish the site' })).toBeDisabled();
  });
});

describe('PublishChecklist drawings of the site (ADR-049 part B)', () => {
  const drawingRow = (
    n: number,
    kind: 'general' | 'secondary',
    ordinal: number,
    state: 'draft' | 'published' | 'not_ready',
  ) => ({
    drawingId: `11111111-1111-4111-8111-11111111111${n}`,
    drawingKind: kind,
    ordinal,
    draftRevisionId: state === 'draft' ? `22222222-2222-4222-8222-22222222222${n}` : null,
    state,
    checks: [],
    warningCount: 0,
    installation: null,
    boxTypes: null,
  });

  it('lists every drawing of the site with its state, as words and marks', () => {
    setup({
      ...readiness(['site_drawings'], { site_drawings: 1 }),
      drawings: [
        drawingRow(1, 'general', 1, 'published'),
        drawingRow(2, 'secondary', 1, 'draft'),
        drawingRow(3, 'secondary', 2, 'not_ready'),
      ],
    } as LegacyReadiness);
    const items = screen.getAllByRole('listitem').filter((li) => li.hasAttribute('data-state'));
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('General');
    expect(items[0]).toHaveTextContent('Already published');
    expect(items[1]).toHaveTextContent(/Secondary \u20661\u2069/);
    expect(items[1]).toHaveTextContent('Draft, will be published');
    expect(items[2]).toHaveTextContent(/Secondary \u20662\u2069/);
    expect(items[2]).toHaveTextContent('Not ready');
    expect(items[2]).toHaveTextContent('❌');
  });

  it('links the draft of another drawing, but not a published one', () => {
    setup(
      {
        ...readiness(),
        drawings: [
          drawingRow(1, 'general', 1, 'published'),
          drawingRow(2, 'secondary', 1, 'draft'),
        ],
      } as LegacyReadiness,
      { revisionHref: (id) => `/en/projects/p/design-revisions/${id}` },
    );
    const links = screen.getAllByRole('link', { name: 'Open the draft' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      '/en/projects/p/design-revisions/22222222-2222-4222-8222-222222222222',
    );
  });

  it('says one publish covers every draft of the site', () => {
    setup(readiness());
    expect(screen.getByText(/every draft of this site together/)).toBeInTheDocument();
  });
});

describe('PublishChecklist cabinets of other sites', () => {
  it('names each cabinet and the site that already has it', () => {
    setup({
      ...readiness(['cabinets_other_site'], { cabinets_other_site: 2 }),
      cabinetsInOtherSites: [
        {
          name: '1-9',
          otherSiteId: '3b000000-0000-4000-8000-00000000000b',
          otherSiteName: 'Site B',
        },
        {
          name: '2-1',
          otherSiteId: '3c000000-0000-4000-8000-00000000000c',
          otherSiteName: 'Site C',
        },
      ],
    });
    expect(screen.getByText(/No cabinet name is also in another site/)).toBeInTheDocument();
    expect(screen.getByText(/1-9.* is in the site Site B/)).toBeInTheDocument();
    expect(screen.getByText(/2-1.* is in the site Site C/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish the site' })).toBeDisabled();
  });
});

describe('PublishChecklist cabinets row (ADR-041)', () => {
  it('has the sixth row, done when the cabinets match', () => {
    setup(readiness());
    expect(
      screen.getByText('Cabinets match in both drawings (name and count)'),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('listitem').filter((li) => li.textContent?.includes('✅')),
    ).toHaveLength(9);
    expect(screen.queryByText(/Only in the General/)).not.toBeInTheDocument();
  });

  it('lists the names that exist in one drawing only, and the counts', () => {
    const data: LegacyReadiness = {
      ...readiness(['cabinets_match'], { cabinets_match: 3 }),
      cabinets: {
        ok: false,
        general: { drawingId: null, count: 9, unnamed: 0 },
        secondaries: [
          {
            drawingId: '11111111-1111-4111-8111-111111111111',
            ordinal: 1,
            side: { count: 8, unnamed: 1, missingInOther: ['1-8'] },
          },
        ],
        inSeveralSecondaries: [],
        missingInGeneral: ['1-8'],
        missingInSecondaries: ['1-9', '2-1'],
      },
    };
    setup(data);
    expect(screen.getByText('❌')).toBeInTheDocument();
    expect(screen.getByText(/Cabinets: General .*9.* \/ Secondaries .*8/)).toBeInTheDocument();
    const general = screen.getByText(/Only in the General/);
    expect(general).toHaveTextContent('1-9');
    expect(general).toHaveTextContent('2-1');
    expect(screen.getByText(/Only in a Secondary/)).toHaveTextContent('1-8');
    expect(screen.getByText(/Cabinets with no name: .*1/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish the site' })).toBeDisabled();
  });

  it('shows the warning count without blocking', () => {
    setup({ ...readiness(), warningCount: 3 });
    expect(screen.getByText(/3.* warning\(s\) in this drawing/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish the site' })).toBeEnabled();
  });
});

describe('RevisionStatusBadge', () => {
  it.each([
    ['queued', 'Queued', '…'],
    ['building', 'Building', '⟳'],
    ['draft', 'Draft', '✎'],
    ['failed', 'Failed', '✕'],
    ['published', 'Published', '✓'],
    ['discarded', 'Discarded', '⊘'],
  ] as const)('shows %s with an icon and text, not colour alone', (status, label, icon) => {
    renderScreen(<RevisionStatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText(icon)).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('PublishChecklist installation row (ADR-042)', () => {
  const route = 'A1F';
  function withIssues(issues: InstallationIssue[]): LegacyReadiness {
    return {
      ...readiness(['installation'], { installation: issues.length }),
      installation: {
        applies: true,
        frozen: null,
        ok: false,
        issueCount: issues.length,
        issues,
        totals: null,
      },
    };
  }
  const issue = (code: InstallationIssue['code'], more: Partial<InstallationIssue> = {}) => ({
    code,
    markIds: [],
    routeHandle: null,
    featureId: null,
    markedM: null,
    routeLengthM: null,
    ...more,
  });

  it.each([
    ['QUESTION_UNANSWERED', /installation question is not answered/],
    ['TRENCH_NOT_MARKED', /marked no part/],
    ['MARKS_WITH_PULL_ONLY', /answer is .All pulled. but there are trench marks/],
  ] as const)('says what %s means', (code, text) => {
    setup(withIssues([issue(code)]));
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByText('❌')).toHaveAttribute('aria-hidden', 'true');
  });

  it('names the route and offers to show it on the drawing', async () => {
    const onShowRoute = vi.fn();
    setup(
      withIssues([
        issue('TRENCH_LONGER_THAN_ROUTE', {
          routeHandle: route,
          markedM: '80.000',
          routeLengthM: '60.000',
        }),
        issue('MARK_ROUTE_MISSING', { routeHandle: 'B2' }),
        issue('ROUTE_LENGTH_UNKNOWN', { routeHandle: 'C3' }),
      ]),
      { onShowRoute },
    );
    expect(screen.getByText(/is longer than the written route length/)).toBeInTheDocument();
    expect(screen.getByText(/has no route in the built drawing/)).toBeInTheDocument();
    expect(screen.getByText(/has no written length/)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Show the place on the drawing' });
    expect(buttons).toHaveLength(3);
    await userEvent.click(buttons[0] as HTMLElement);
    expect(onShowRoute).toHaveBeenCalledWith(route);
  });

  it('is ok on a Secondary, with a note that it is all trench', () => {
    setup({ ...readiness(), drawingKind: 'secondary' });
    expect(screen.getByText('The Secondary is all trench — no question.')).toBeInTheDocument();
  });
});

describe('PublishChecklist box types row (ADR-043)', () => {
  const SHAPE = `v1-${'a'.repeat(64)}`;
  const report = (
    issues: BoxTypesReport['issues'],
    overrides: Partial<BoxTypesReport> = {},
  ): BoxTypesReport => ({
    applies: true,
    gallery: {
      version: 1,
      boxCount: 197,
      shapeCount: 1,
      shapes: [
        {
          shape: SHAPE,
          source: 'block',
          count: 197,
          blockNames: ['box c'],
          sampleHandles: ['B1'],
          preview: null,
        },
      ],
      boxesWithoutShape: 0,
    },
    frozen: null,
    ok: issues.length === 0,
    issueCount: issues.length,
    issues,
    totals: null,
    changedSinceBuild: false,
    ...overrides,
  });

  function secondary(boxTypes: BoxTypesReport | null, count: number | null) {
    const base = readiness(count && count > 0 ? ['box_types'] : [], { box_types: count });
    return { ...base, drawingKind: 'secondary' as const, boxTypes };
  }

  it('has the eighth row, with its words', () => {
    setup(secondary(report([]), 0));
    expect(screen.getByText('Every box shape has a work-order line')).toBeInTheDocument();
  });

  it('lists the issues of a shape and zooms to a sample box', async () => {
    const onShowRoute = vi.fn();
    setup(
      secondary(
        report([{ code: 'BOX_TYPE_UNSET', shape: SHAPE, boxCount: 197, workOrderLineId: null }]),
        1,
      ),
      { onShowRoute },
    );
    expect(screen.getByText(/has no work-order line/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose the line' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show on the drawing' }));
    expect(onShowRoute).toHaveBeenCalledWith('B1');
  });

  it('says the types are set on the Secondary when this is the General', () => {
    setup(readiness());
    expect(screen.getByText('Box types are set on the Secondary drawing.')).toBeInTheDocument();
  });

  describe('switched-off steps (ADR-045)', () => {
    it('hides the ok rows and the texts of the steps the API switched off', () => {
      setup({ ...readiness(), switchedOff: ['installation', 'box_types'] });
      expect(screen.queryByText(/installation/i)).not.toBeInTheDocument();
      expect(screen.queryByText('Every box shape has a work-order line')).not.toBeInTheDocument();
      expect(
        screen.queryByText('Box types are set on the Secondary drawing.'),
      ).not.toBeInTheDocument();
      expect(screen.getByText('Coordinates: source CRS chosen')).toBeInTheDocument();
    });

    it('keeps a switched-off box_types row that is not ok, with its issue', () => {
      const base = readiness(['box_types'], { box_types: 1 });
      setup({
        ...base,
        drawingKind: 'secondary',
        switchedOff: ['installation', 'box_types'],
        boxTypes: {
          applies: true,
          gallery: null,
          frozen: null,
          ok: false,
          issueCount: 1,
          issues: [
            { code: 'READING_ROLES_MISSING', shape: null, boxCount: null, workOrderLineId: null },
          ],
          totals: null,
          changedSinceBuild: false,
        } as BoxTypesReport,
      });
      expect(screen.getByText('Every box shape has a work-order line')).toBeInTheDocument();
      expect(screen.getByText('(Not done)')).toBeInTheDocument();
    });
  });
});
