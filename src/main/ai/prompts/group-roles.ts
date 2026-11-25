import { aiText } from '../../i18n'
import type { GroupMemberTemplate } from '../../../shared/types'

/**
 * 协作群组的内置角色模板。
 *
 * 每个角色 = 展示元数据(渲染层要的)+ 人设提示词(注入给模型的)+
 * 预勾选的内置领域技能(用户可增删)。基础链路:产品经理 → UI设计师 →
 * 后端工程师 → 前端工程师 → 测试工程师;架构师/全栈/DevOps/技术评审员
 * 按需加入。链路**不写死**——每个角色自己判断下一位该是谁,用户也可以
 * 直接 @ 任何人。
 *
 * 产出一律是 markdown 文档,不是实现代码(字段表 / 结构树 / 伪代码可以)。
 */

export type GroupRole = GroupMemberTemplate

export const GROUP_ROLES: GroupRole[] = [
  {
    id: 'pm',
    get name() {
      return aiText('ai.prompts.groupRoles.productManager')
    },
    color: '#e8662c',
    get duty() {
      return aiText('ai.prompts.groupRoles.defineRequirementsDeliverAPrioritizedRequirementsList')
    },
    get deliverable() {
      return aiText('ai.prompts.groupRoles.requirementsDocument')
    },
    get persona() {
      return aiText('ai.prompts.groupRoles.youAreASeniorProductManagerTurnTheUserSIntentInto')
    },
    /*
     * 预勾选的内置项目管理技能(resources/skills-pm,pm-skills-zh)。
     * 只挑与「需求文档」直接相关的一小把——65 个全给等于没给,
     * 其余的用户在成员编辑器的「项目管理(内置)」分组里自己加。
     */
    skillIds: [
      'create-prd',
      'user-stories',
      'prioritization-frameworks',
      'user-personas',
      'competitor-analysis',
      'customer-journey-map',
      'idea-refine',
      'spec-driven-development'
    ]
  },
  {
    id: 'ui',
    get name() {
      return aiText('ai.prompts.groupRoles.uiDesigner')
    },
    color: '#722ed1',
    get duty() {
      return aiText('ai.prompts.groupRoles.interactionFlowsAndVisualDirectionIncludingColors')
    },
    get deliverable() {
      return aiText('ai.prompts.groupRoles.uiAndInteractionDesignDocument')
    },
    get persona() {
      return aiText('ai.prompts.groupRoles.youAreASeniorUiUxDesignerDefineTheDesignFromThe')
    },
    skillIds: [
      'baseline-ui',
      'improve-ui',
      'fixing-accessibility',
      'fixing-motion-performance',
      'create-design-md'
    ]
  },
  {
    id: 'be',
    get name() {
      return aiText('ai.prompts.groupRoles.backendEngineer')
    },
    color: '#2f7fd6',
    get duty() {
      return aiText('ai.prompts.groupRoles.databaseSchemaAndApiDesign')
    },
    get deliverable() {
      return aiText('ai.prompts.groupRoles.databaseAndApiDesignDocument')
    },
    get persona() {
      return aiText('ai.prompts.groupRoles.youAreASeniorBackendEngineerDesignDataAndApisFromThe')
    },
    skillIds: ['api-and-interface-design', 'ddd-domain-designer', 'postgresql', 'mysql', 'redis']
  },
  {
    id: 'fe',
    get name() {
      return aiText('ai.prompts.groupRoles.frontendEngineer')
    },
    color: '#31a06e',
    get duty() {
      return aiText('ai.prompts.groupRoles.pageStructureAndComponentDecomposition')
    },
    get deliverable() {
      return aiText('ai.prompts.groupRoles.frontendStructureDesignDocument')
    },
    get persona() {
      return aiText('ai.prompts.groupRoles.youAreASeniorFrontendEngineer')
    },
    skillIds: ['vue3', 'pinia', 'antdv-next', 'react', 'frontend-ui-engineering']
  },
  {
    id: 'qa',
    get name() {
      return aiText('ai.prompts.groupRoles.qaEngineer')
    },
    color: '#b23a48',
    get duty() {
      return aiText('ai.prompts.groupRoles.testCasesAndAcceptanceChecklist')
    },
    get deliverable() {
      return aiText('ai.prompts.groupRoles.testCaseDocument')
    },
    get persona() {
      return aiText('ai.prompts.groupRoles.youAreASeniorQaEngineerDesignTestsBasedOnAllPreceding')
    },
    skillIds: ['test-driven-development', 'webapp-testing', 'playwright', 'vitest']
  },
  {
    id: 'arch',
    get name() {
      return aiText('ai.prompts.groupRoles.architect')
    },
    color: '#d4a017',
    get duty() {
      return aiText('ai.prompts.groupRoles.domainModelingAndArchitectureSelection')
    },
    get deliverable() {
      return aiText('ai.prompts.groupRoles.architectureDesignDocument')
    },
    get persona() {
      return aiText('ai.prompts.groupRoles.youAreASeniorSoftwareArchitect')
    },
    skillIds: [
      'ddd-domain-designer',
      'ddd-event-storming',
      'ddd-architecture-selector',
      'ddd-api-designer',
      'api-and-interface-design',
      'documentation-and-adrs'
    ]
  },
  {
    id: 'fs',
    get name() {
      return aiText('ai.prompts.groupRoles.fullStackEngineer')
    },
    color: '#13a8a8',
    get duty() {
      return aiText('ai.prompts.groupRoles.anEndToEndTechnicalPlanSpanningFrontendAndBackend')
    },
    get deliverable() {
      return aiText('ai.prompts.groupRoles.technicalDesignDocument')
    },
    get persona() {
      return aiText('ai.prompts.groupRoles.youAreASeniorFullStack')
    },
    skillIds: ['vue3', 'pinia', 'antdv-next', 'nestjs', 'postgresql', 'api-and-interface-design']
  },
  {
    id: 'devops',
    get name() {
      return aiText('ai.prompts.groupRoles.devopsEngineer')
    },
    color: '#8d6e63',
    get duty() {
      return aiText('ai.prompts.groupRoles.deploymentReleaseAndObservabilityPlanning')
    },
    get deliverable() {
      return aiText('ai.prompts.groupRoles.deploymentAndOperationsPlan')
    },
    get persona() {
      return aiText('ai.prompts.groupRoles.youAreASeniorDevopsEngineer')
    },
    skillIds: [
      'github-actions',
      'kubernetes',
      'terraform',
      'ansible',
      'ci-cd-and-automation',
      'observability-and-instrumentation'
    ]
  },
  {
    id: 'reviewer',
    get name() {
      return aiText('ai.prompts.groupRoles.technicalReviewer')
    },
    color: '#d6598f',
    get duty() {
      return aiText('ai.prompts.groupRoles.reviewQualityAndRisksAcrossAllDocuments')
    },
    get deliverable() {
      return aiText('ai.prompts.groupRoles.technicalReviewReport')
    },
    get persona() {
      return aiText('ai.prompts.groupRoles.youAreASeniorTechnicalReviewer')
    },
    skillIds: [
      'code-review-and-quality',
      'security-and-hardening',
      'performance-optimization',
      'code-simplification',
      'doubt-driven-development'
    ]
  }
]

/** 建群编辑器使用的模板副本；技能预勾选、模型留给用户选 */
export function roleTemplates(): GroupMemberTemplate[] {
  return GROUP_ROLES.map(({ id, name, color, duty, deliverable, persona, skillIds }) => ({
    id,
    name,
    color,
    duty,
    deliverable,
    persona,
    skillIds: skillIds ? [...skillIds] : undefined
  }))
}
