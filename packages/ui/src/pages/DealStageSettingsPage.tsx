import { ErrorPanel, LoadingPanel } from '../components/QueryState.tsx'
import { StageSettings } from '../components/StageSettings.tsx'
import {
  useCreatePipelineStage,
  usePipelineStages,
  useRemovePipelineStage,
  useUpdatePipelineStage,
} from '../api/resources/pipelineStages.ts'

/**
 * The deal pipeline's stage settings. `StageSettings` is the shared editor;
 * Opportunities, Raises and Partnerships mount it against their own kind when
 * those pipelines land.
 */
export function DealStageSettingsPage(): React.JSX.Element {
  const stages = usePipelineStages('deal')
  const createStage = useCreatePipelineStage()
  const updateStage = useUpdatePipelineStage()
  const removeStage = useRemovePipelineStage()

  if (stages.error !== null) {
    return <ErrorPanel error={stages.error} />
  }

  if (stages.isLoading) {
    return <LoadingPanel label="Loading stages…" />
  }

  const ordered = [...stages.records].sort((a, b) => a.sortOrder - b.sortOrder)
  const writeError = createStage.error ?? updateStage.error ?? removeStage.error

  return (
    <>
      {writeError !== null && (
        <div className="mx-auto mb-3 max-w-xl">
          <ErrorPanel error={writeError} />
        </div>
      )}
      <StageSettings
        title="Deal stages"
        backTo="/deals"
        backLabel="Deals"
        recordNoun="deal"
        stages={ordered}
        onRename={(id, label) => {
          updateStage.run({ id, changes: { label } })
        }}
        onReorder={(activeId, overId) => {
          const position = ordered.findIndex((stage) => stage.id === overId)

          if (position >= 0) {
            updateStage.run({ id: activeId, changes: { sortOrder: position } })
          }
        }}
        onToggleOpen={(id, open) => {
          updateStage.run({ id, changes: { open } })
        }}
        onAdd={(label) => {
          createStage.run({ kind: 'deal', label })
        }}
        onRemove={(id, moveToId) => {
          removeStage.run({ id, moveToId })
        }}
      />
    </>
  )
}
