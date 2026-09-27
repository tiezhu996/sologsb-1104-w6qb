import { create } from 'zustand'
import type { Diagram } from '../types/diagram'
import type { Furniture, FurnitureName } from '../types/furniture'
import type { JointType } from '../types/jointType'
import type { Member } from '../types/member'
import type { DisassemblyStep } from '../types/step'
import { db, ensureSeedData } from '../utils/db'

export type JointDraft = Omit<JointType, 'id' | 'schemaRev'>
export type FurnitureDraft = Omit<Furniture, 'id' | 'schemaRev'>

interface JointState {
  joints: JointType[]
  members: Member[]
  furniture: Furniture[]
  stepCounts: Record<string, number>
  selectedJointId: string | null
  loading: boolean
  loadAll: () => Promise<void>
  addJoint: (draft: JointDraft) => Promise<JointType>
  duplicateJoint: (sourceId: string, name: string) => Promise<JointType | null>
  addFurniture: (draft: FurnitureDraft) => Promise<Furniture>
  setSelectedJoint: (id: string) => void
  updateMemberDimensions: (
    memberId: string,
    dimensions: Pick<Member, 'lengthMm' | 'widthMm' | 'thicknessMm' | 'toleranceMm'>,
  ) => Promise<void>
  renameMember: (memberId: string, name: Member['name']) => Promise<void>
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

function remapSvgMemberIds(markup: string, memberIdMap: Map<string, string>): string {
  let remapped = markup
  memberIdMap.forEach((newId, oldId) => {
    remapped = remapped
      .split(`data-member-id="${oldId}"`).join(`data-member-id="${newId}"`)
      .split(`data-member-id='${oldId}'`).join(`data-member-id='${newId}'`)
  })
  return remapped
}

export const useJointStore = create<JointState>((set, get) => ({
  joints: [],
  members: [],
  furniture: [],
  stepCounts: {},
  selectedJointId: null,
  loading: false,

  loadAll: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      await ensureSeedData()
      const [joints, members, furniture, steps] = await Promise.all([
        db.joints.toArray(),
        db.members.toArray(),
        db.furniture.toArray(),
        db.steps.toArray(),
      ])
      const stepCounts = steps.reduce<Record<string, number>>((counts, step) => {
        counts[step.jointTypeId] = (counts[step.jointTypeId] ?? 0) + 1
        return counts
      }, {})
      const selectedJointId = get().selectedJointId
      set({
        joints: joints.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
        members,
        furniture,
        stepCounts,
        selectedJointId: selectedJointId && joints.some((joint) => joint.id === selectedJointId)
          ? selectedJointId
          : joints[0]?.id ?? null,
      })
    } finally {
      set({ loading: false })
    }
  },

  addJoint: async (draft) => {
    const joint: JointType = { ...draft, id: createId('joint'), schemaRev: 2 }
    await db.joints.add(joint)
    set((state) => ({
      joints: [...state.joints, joint].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      selectedJointId: joint.id,
      stepCounts: { ...state.stepCounts, [joint.id]: 0 },
    }))
    return joint
  },

  duplicateJoint: async (sourceId, name) => {
    const trimmed = name.trim()
    if (!trimmed) return null
    const source = await db.joints.get(sourceId)
    if (!source) return null
    const [sourceMembers, sourceSteps, sourceDiagrams, sourceFurniture] = await Promise.all([
      db.members.where('jointTypeId').equals(sourceId).toArray(),
      db.steps.where('jointTypeId').equals(sourceId).toArray(),
      db.diagrams.where('jointTypeId').equals(sourceId).toArray(),
      db.furniture.where('jointTypeId').equals(sourceId).toArray(),
    ])
    const joint: JointType = {
      ...source,
      id: createId('joint'),
      name: trimmed as JointType['name'],
      copiedFromId: source.id,
      schemaRev: 2,
    }
    const memberIdMap = new Map<string, string>()
    const copiedMembers: Member[] = sourceMembers.map((member) => {
      const id = createId('member')
      memberIdMap.set(member.id, id)
      return { ...member, id, jointTypeId: joint.id, schemaRev: 2 }
    })
    const stepIdMap = new Map<string, string>()
    const copiedSteps: DisassemblyStep[] = sourceSteps.map((step) => {
      const id = createId('step')
      stepIdMap.set(step.id, id)
      return { ...step, id, jointTypeId: joint.id, schemaRev: 2 }
    })
    const copiedDiagrams: Diagram[] = sourceDiagrams.map((diagram) => ({
      ...diagram,
      id: createId('diagram'),
      jointTypeId: joint.id,
      stepId: stepIdMap.get(diagram.stepId) ?? diagram.stepId,
      svgMarkup: remapSvgMemberIds(diagram.svgMarkup, memberIdMap),
      hitAreas: diagram.hitAreas.map((area) => ({
        ...area,
        id: createId('hit'),
        memberId: memberIdMap.get(area.memberId) ?? area.memberId,
      })),
      schemaRev: 2,
    }))
    const copiedFurniture: Furniture[] = sourceFurniture.map((item) => ({
      ...item,
      id: createId('furniture'),
      jointTypeId: joint.id,
      schemaRev: 2,
    }))
    await db.transaction('rw', [db.joints, db.members, db.steps, db.diagrams, db.furniture], async () => {
      await db.joints.add(joint)
      await db.members.bulkAdd(copiedMembers)
      await db.steps.bulkAdd(copiedSteps)
      await db.diagrams.bulkAdd(copiedDiagrams)
      await db.furniture.bulkAdd(copiedFurniture)
    })
    set((state) => ({
      joints: [...state.joints, joint].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
      members: [...state.members, ...copiedMembers],
      furniture: [...state.furniture, ...copiedFurniture],
      stepCounts: { ...state.stepCounts, [joint.id]: copiedSteps.length },
      selectedJointId: joint.id,
    }))
    return joint
  },

  addFurniture: async (draft) => {
    const furniture: Furniture = { ...draft, id: createId('furniture'), schemaRev: 2 }
    await db.furniture.add(furniture)
    set((state) => ({ furniture: [...state.furniture, furniture] }))
    return furniture
  },

  setSelectedJoint: (id) => set({ selectedJointId: id }),

  updateMemberDimensions: async (memberId, dimensions) => {
    await db.members.update(memberId, dimensions)
    set((state) => ({
      members: state.members.map((member) => (
        member.id === memberId ? { ...member, ...dimensions } : member
      )),
    }))
  },

  renameMember: async (memberId, name) => {
    await db.members.update(memberId, { name })
    set((state) => ({
      members: state.members.map((member) => (
        member.id === memberId ? { ...member, name } : member
      )),
    }))
  },
}))

export type { FurnitureName }
