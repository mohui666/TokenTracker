import React, { useCallback, useState } from "react";
import { motion } from "motion/react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Shell, Card } from "../../components";
import { CostAnalysisModal } from "../components/CostAnalysisModal.jsx";
import { DataDetails } from "../components/DataDetails.jsx";
import { StatsPanel } from "../components/StatsPanel.jsx";
import { UsageOverview } from "../components/UsageOverview.jsx";
import { TrendMonitor } from "../components/TrendMonitor.jsx";
import { SortableCard } from "../components/SortableCard.jsx";
import { FadeIn } from "../../foundation/FadeIn.jsx";
import { MacAppBanner } from "../components/MacAppBanner.jsx";
import { WidgetOnboardingCard } from "../components/WidgetOnboardingCard.jsx";
import { IslandOnboardingCard } from "../components/IslandOnboardingCard.jsx";
import { QualityPerDollarCard } from "../components/QualityPerDollarCard.jsx";
import { SessionInsightsCard } from "../components/SessionInsightsCard.jsx";
import { cn } from "../../../lib/cn";

// Entrance stagger timing — computed from each column's *rendered* index so
// the waterfall still looks right after a user drags cards into a new order.
const STEP = 0.06;
const D_LEFT_BASE = 0.11;
const D_RIGHT_BASE = 0.05;
// islandOnboarding must NOT be prunable: it renders null until the native
// bridge pushes settings (async), and a pruned card is unmounted for good —
// it would never get the chance to appear once settings arrive.
const EMPTY_PRUNABLE_CARD_IDS = new Set(["macAppBanner", "widgetOnboarding"]);

export function DashboardView(props) {

  const {
    copy,
    onOpenShare,
    screenshotMode,
    identityDisplayName,
    identityStartDate,
    activeDays,
    identitySubscriptions,
    identityScrambleDurationMs,
    projectUsageEntries,
    projectUsageLimit,
    setProjectUsageLimit,
    projectDetailQuery,
    topModels,
    isLocalMode,
    shouldShowInstall,
    installPrompt,
    handleCopyInstall,
    installCopied,
    installInitCmdDisplay,
    trendRowsForDisplay,
    trendFromForDisplay,
    trendToForDisplay,
    trendZoomConfig,
    usageFrom,
    usageTo,
    period,
    trendTimeZoneLabel,
    activityHeatmapBlock,
    periodsForDisplay,
    setSelectedPeriod,
    customFrom,
    customTo,
    onCustomRangeApply,
    customRangeOpen,
    onCustomRangeOpenChange,
    summaryLabel,
    summaryValue,
    summaryFullValue,
    hasSummary,
    summaryLoading,
    providersLoading,
    onToggleSummaryFormat,
    summaryTotalTokensRaw,
    summaryCostValue,
    summaryConversationsValue,
    rollingUsage,
    costInfoEnabled,
    openCostModal,
    costModalOpen,
    closeCostModal,
    allowBreakdownToggle,
    refreshAll,
    usageLoadingState,
    announceUsageLoading,
    fleetData,
    hasDetailsActual,
    dailyEmptyPrefix,
    installSyncCmd,
    dailyEmptySuffix,
    detailsColumns,
    ariaSortFor,
    toggleSort,
    sortIconFor,
    pagedDetails,
    dailyBreakdownRows,
    dailyBreakdownColumns,
    dailyBreakdownAriaSortFor,
    dailyBreakdownSortIconFor,
    dailyBreakdownDateKey,
    detailsDateKey,
    renderDetailDate,
    renderDailyBreakdownDate,
    renderDetailCell,
    DETAILS_PAGED_PERIODS,
    detailsPageCount,
    detailsPage,
    setDetailsPage,
    leftCardOrder,
    onLeftReorder,
    rightCardOrder,
    onRightReorder,
  } = props;

  // Header 和 Footer 已简化
  const header = null;
  const footer = null;

  // Cards that are permanently hidden after mount (dismissed native banners,
  // widget onboarding) get dropped from sortable `items` entirely. Async cards
  // such as QualityPerDollarCard must stay mounted while their data loads.
  const [emptyCardIds, setEmptyCardIds] = useState(() => new Set());
  const handleCardEmptyChange = useCallback((id, isEmpty) => {
    if (!EMPTY_PRUNABLE_CARD_IDS.has(id)) return;
    setEmptyCardIds((prev) => {
      if (prev.has(id) === isEmpty) return prev;
      const next = new Set(prev);
      if (isEmpty) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const leftVisible = {
    macAppBanner: isLocalMode,
    statsPanel: true,
    islandOnboarding: isLocalMode,
    widgetOnboarding: isLocalMode,
    installCopy: shouldShowInstall,
    activityHeatmap: Boolean(activityHeatmapBlock),
    trendMonitor: !screenshotMode,
    qualityPerDollar: !screenshotMode,
    sessionInsights: isLocalMode && !screenshotMode,
  };
  const visibleLeftOrder = (leftCardOrder || []).filter(
    (id) => leftVisible[id] && !emptyCardIds.has(id),
  );

  const rightVisible = {
    usageOverview: true,
    dataDetails: !screenshotMode,
  };
  const visibleRightOrder = (rightCardOrder || []).filter(
    (id) => rightVisible[id] && !emptyCardIds.has(id),
  );

  function renderLeftCard(id, delay) {
    switch (id) {
      case "macAppBanner": {
        return (
          <MacAppBanner
            todayTokens={summaryTotalTokensRaw}
            isSyncing={usageLoadingState}
            enterDelay={delay}
          />
        );
      }
      case "statsPanel": {
        return (
          <FadeIn delay={delay}>
            <StatsPanel
              title={copy("dashboard.identity.title")}
              subtitle={copy("dashboard.identity.subtitle")}
              period={period}
              startDate={identityStartDate ?? copy("identity_card.rank_placeholder")}
              streakDays={activeDays}
              subscriptions={identitySubscriptions}
              periodConversations={summaryConversationsValue}
              rolling={rollingUsage}
              topModels={topModels}
            />
          </FadeIn>
        );
      }
      case "islandOnboarding": {
        return <IslandOnboardingCard enterDelay={delay} />;
      }
      case "widgetOnboarding": {
        return <WidgetOnboardingCard enterDelay={delay} />;
      }
      case "installCopy": {
        return (
          <FadeIn delay={delay}>
            <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-3">
              <div className="text-xs text-oai-gray-500 dark:text-oai-gray-300 mb-1.5">{installPrompt}</div>
              <motion.button
                onClick={handleCopyInstall}
                whileHover={{ scale: 1.01 }}
                whileTap={{ scale: 0.99 }}
                className="w-full flex items-center justify-between px-3 py-2 bg-oai-gray-50 dark:bg-oai-gray-800 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-700 rounded-lg transition-colors"
              >
                <code className="text-xs font-mono text-oai-gray-700 dark:text-oai-gray-300">{installInitCmdDisplay}</code>
                <motion.span
                  key={installCopied ? "copied" : "copy"}
                  initial={{ opacity: 0, y: -5 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-xs text-oai-brand"
                >
                  {installCopied ? "Copied ✓" : "Copy"}
                </motion.span>
              </motion.button>
            </div>
          </FadeIn>
        );
      }
      case "activityHeatmap": {
        return <FadeIn delay={delay}>{activityHeatmapBlock}</FadeIn>;
      }
      case "trendMonitor": {
        return (
          <FadeIn delay={delay}>
            <TrendMonitor
              rows={trendRowsForDisplay}
              from={trendFromForDisplay}
              to={trendToForDisplay}
              period={period}
              timeZoneLabel={trendTimeZoneLabel}
              showTimeZoneLabel={false}
              zoomConfig={trendZoomConfig}
            />
          </FadeIn>
        );
      }
      case "qualityPerDollar": {
        return (
          <QualityPerDollarCard
            from={usageFrom}
            to={usageTo}
          />
        );
      }
      case "sessionInsights": {
        return <SessionInsightsCard from={usageFrom} to={usageTo} />;
      }
      default: {
        return null;
      }
    }
  }

  function renderRightCard(id, delay) {
    switch (id) {
      case "usageOverview": {
        return (
          <FadeIn delay={delay}>
            <UsageOverview
              period={period}
              periods={periodsForDisplay}
              onPeriodChange={setSelectedPeriod}
              summaryLabel={summaryLabel}
              summaryValue={summaryValue}
              summaryFullValue={summaryFullValue}
              hasSummary={hasSummary}
              summaryLoading={summaryLoading}
              providersLoading={providersLoading}
              onToggleSummaryFormat={hasSummary ? onToggleSummaryFormat : null}
              summaryCostValue={summaryCostValue}
              onCostInfo={costInfoEnabled ? openCostModal : null}
              fleetData={fleetData}
              onRefresh={screenshotMode ? null : refreshAll}
              loading={usageLoadingState}
              announceLoading={announceUsageLoading}
              onOpenShare={screenshotMode ? null : onOpenShare}
              customFrom={customFrom}
              customTo={customTo}
              onCustomRangeApply={onCustomRangeApply}
              customRangeOpen={customRangeOpen}
              onCustomRangeOpenChange={onCustomRangeOpenChange}
              from={usageFrom}
              to={usageTo}
            />
          </FadeIn>
        );
      }
      case "dataDetails": {
        return (
          <FadeIn delay={delay}>
            <DataDetails
              projectEntries={projectUsageEntries}
              projectLimit={projectUsageLimit}
              onProjectLimitChange={setProjectUsageLimit}
              projectDetailQuery={projectDetailQuery}
              copy={copy}
              hasDetailsActual={hasDetailsActual}
              dailyEmptyPrefix={dailyEmptyPrefix}
              installSyncCmd={installSyncCmd}
              dailyEmptySuffix={dailyEmptySuffix}
              detailsColumns={detailsColumns}
              ariaSortFor={ariaSortFor}
              toggleSort={toggleSort}
              sortIconFor={sortIconFor}
              pagedDetails={pagedDetails}
              dailyBreakdownRows={dailyBreakdownRows}
              dailyBreakdownColumns={dailyBreakdownColumns}
              dailyBreakdownAriaSortFor={dailyBreakdownAriaSortFor}
              dailyBreakdownSortIconFor={dailyBreakdownSortIconFor}
              dailyBreakdownDateKey={dailyBreakdownDateKey}
              detailsDateKey={detailsDateKey}
              renderDetailDate={renderDetailDate}
              renderDailyBreakdownDate={renderDailyBreakdownDate}
              renderDetailCell={renderDetailCell}
              DETAILS_PAGED_PERIODS={DETAILS_PAGED_PERIODS}
              period={period}
              detailsPageCount={detailsPageCount}
              detailsPage={detailsPage}
              setDetailsPage={setDetailsPage}
            />
          </FadeIn>
        );
      }
      default: {
        return null;
      }
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleLeftDragEnd = useCallback(
    (event) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      onLeftReorder?.(String(active.id), String(over.id));
    },
    [onLeftReorder],
  );

  const handleRightDragEnd = useCallback(
    (event) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      onRightReorder?.(String(active.id), String(over.id));
    },
    [onRightReorder],
  );

  function renderSortableColumn(order, renderCard, baseDelay, onDragEnd) {
    if (screenshotMode) {
      return (
        <>
          {order.map((id, i) => (
            <React.Fragment key={id}>{renderCard(id, baseDelay + STEP * i)}</React.Fragment>
          ))}
        </>
      );
    }
    return (
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <SortableContext items={order} strategy={verticalListSortingStrategy}>
          {order.map((id, i) => (
            <SortableCard key={id} id={id} onEmptyChange={handleCardEmptyChange}>
              {renderCard(id, baseDelay + STEP * i)}
            </SortableCard>
          ))}
        </SortableContext>
      </DndContext>
    );
  }

  const leftColumnContent = renderSortableColumn(
    visibleLeftOrder,
    renderLeftCard,
    D_LEFT_BASE,
    handleLeftDragEnd,
  );
  const rightColumnContent = renderSortableColumn(
    visibleRightOrder,
    renderRightCard,
    D_RIGHT_BASE,
    handleRightDragEnd,
  );

  return (
    <>
      <Shell
        bare={!screenshotMode}
        hideHeader={screenshotMode}
        header={header}
        footer={!screenshotMode ? footer : null}
        className={screenshotMode ? "screenshot-mode" : ""}
      >
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-4 flex flex-col gap-4 min-w-0 order-2 lg:order-1">
            {leftColumnContent}
          </div>

          <div className="lg:col-span-8 flex flex-col gap-4 min-w-0 order-1 lg:order-2">
            {rightColumnContent}
          </div>
        </div>
      </Shell>
      <CostAnalysisModal isOpen={costModalOpen} onClose={closeCostModal} fleetData={fleetData} />
    </>
  );
}
