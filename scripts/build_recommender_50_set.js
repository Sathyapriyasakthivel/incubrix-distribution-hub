import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleDestinations } from '../src/database/seeds/destinationsData.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Map valid destination IDs
const validDestMap = new Map();
sampleDestinations.forEach(d => {
  validDestMap.set(d.id, d);
});

console.log(`Loaded ${validDestMap.size} valid destinations from catalogue seeds.`);

// Define 50 realistic, diverse content items for evaluation
const items = [
  // 1. AI & LLM Engineering (10 items)
  {
    id: 'content_01',
    title: 'Fine-Tuning Open Source LLMs on Domain-Specific Coding Datasets',
    body: 'Step-by-step practical guide to LoRA fine-tuning for domain-specific coding assistants using Hugging Face Transformers.',
    tags: ['AI', 'LLM', 'OpenSource', 'MachineLearning', 'Python'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ai/lora-finetuning',
    reviewed_by: null,
    target_categories: ['AI', 'LLM', 'Deep Learning'],
    relevant_destinations: [
      'dest_openai_developer_forum',
      'dest_hugging_face_discussion_forum',
      'dest_fast_ai_deep_learning_community'
    ]
  },
  {
    id: 'content_02',
    title: 'Optimizing Context Window Memory in Retrieval-Augmented Generation (RAG)',
    body: 'Architectural evaluation of hybrid dense-sparse vector search and chunk reranking to minimize hallucination in production RAG.',
    tags: ['AI', 'LLM', 'RAG', 'VectorSearch', 'Python'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ai/rag-optimization',
    reviewed_by: null,
    relevant_destinations: [
      'dest_openai_developer_forum',
      'dest_hugging_face_discussion_forum',
      'dest_fast_ai_deep_learning_community'
    ]
  },
  {
    id: 'content_03',
    title: 'Prompt Injection Defense Patterns for Autonomous LLM Agents',
    body: 'Hardening tool-calling agent architectures against untrusted prompt injection using deterministic input filtering and semantic verification.',
    tags: ['AI', 'Security', 'LLM', 'Agents', 'Python'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ai/prompt-injection-defense',
    reviewed_by: null,
    relevant_destinations: [
      'dest_openai_developer_forum',
      'dest_hugging_face_discussion_forum'
    ]
  },
  {
    id: 'content_04',
    title: 'Benchmarking Fast Scientific Computing and Differentiable Programming in Julia',
    body: 'Evaluating Julia compilation speed and automatic differentiation benchmarks against Python PyTorch in scientific machine learning.',
    tags: ['AI', 'Julia', 'MachineLearning', 'Scientific', 'Performance'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/julia-sciml',
    reviewed_by: null,
    relevant_destinations: [
      'dest_julia_language_discourse',
      'dest_fast_ai_deep_learning_community'
    ]
  },
  {
    id: 'content_05',
    title: 'High-Throughput Local Model Serving with vLLM PagedAttention',
    body: 'Configuring continuous batching, tensor parallelism, and KV cache paging for cost-effective private LLM hosting.',
    tags: ['AI', 'LLM', 'MLOps', 'Infrastructure', 'OpenSource'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ai/vllm-serving',
    reviewed_by: null,
    relevant_destinations: [
      'dest_hugging_face_discussion_forum',
      'dest_openai_developer_forum'
    ]
  },
  {
    id: 'content_06',
    title: 'Building Declarative Workflow Chains for LangChain Agents',
    body: 'Designing modular LangChain prompt pipelines with structured output parsing and deterministic JSON schema validation.',
    tags: ['AI', 'LLM', 'Python', 'Automation', 'Developers'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ai/langchain-pipelines',
    reviewed_by: null,
    relevant_destinations: [
      'dest_openai_developer_forum',
      'dest_hugging_face_discussion_forum'
    ]
  },
  {
    id: 'content_07',
    title: 'Computer Vision Object Tracking on Edge Devices with TensorRT',
    body: 'Quantizing neural network weights to INT8 and profiling latency on NVIDIA Jetson embedded hardware.',
    tags: ['AI', 'ComputerVision', 'Edge', 'Python', 'Hardware'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ai/edge-cv',
    reviewed_by: null,
    relevant_destinations: [
      'dest_fast_ai_deep_learning_community',
      'dest_hugging_face_discussion_forum'
    ]
  },
  {
    id: 'content_08',
    title: 'Practical Fine-Tuning of Small Language Models (SLMs) for Mobile Apps',
    body: 'Optimizing 3B parameter models for on-device inference with minimal battery and memory overhead.',
    tags: ['AI', 'LLM', 'Mobile', 'OpenSource', 'Optimization'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ai/slm-mobile',
    reviewed_by: null,
    relevant_destinations: [
      'dest_hugging_face_discussion_forum',
      'dest_openai_developer_forum'
    ]
  },
  {
    id: 'content_09',
    title: 'Multi-Agent Collaboration Protocols: Architectures and Failure Modes',
    body: 'Case study analyzing message protocols, consensus loops, and deadlock resolution among autonomous agent swarms.',
    tags: ['AI', 'Agents', 'LLM', 'Architecture', 'Research'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ai/agent-collaboration',
    reviewed_by: null,
    relevant_destinations: [
      'dest_openai_developer_forum',
      'dest_hugging_face_discussion_forum'
    ]
  },
  {
    id: 'content_10',
    title: 'Evaluating Open Source Embedding Models on Multilingual RAG',
    body: 'Comparing MTEB benchmark leaderboards against custom production queries in English, German, and Spanish.',
    tags: ['AI', 'Embeddings', 'Search', 'RAG', 'OpenSource'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ai/embedding-benchmarks',
    reviewed_by: null,
    relevant_destinations: [
      'dest_hugging_face_discussion_forum',
      'dest_fast_ai_deep_learning_community'
    ]
  },

  // 2. SaaS & Product Analytics (10 items)
  {
    id: 'content_11',
    title: 'Tracking Feature Adoption and Retention Funnels with Self-Hosted PostHog',
    body: 'Setting up event pipelines, group analytics, and retention insight cohorts without sending user data to third-party ad networks.',
    tags: ['SaaS', 'Analytics', 'Founders', 'Product', 'Growth'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/saas/posthog-analytics',
    reviewed_by: null,
    relevant_destinations: [
      'dest_posthog_community_forum'
    ]
  },
  {
    id: 'content_12',
    title: 'Bootstrapping B2B Micro-SaaS to $10k MRR Without Venture Funding',
    body: 'Pricing strategies, outbound founder-led sales scripts, and customer onboarding loops for solo technical developers.',
    tags: ['SaaS', 'Bootstrapping', 'Founders', 'Startups', 'Revenue'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/saas/bootstrap-10k',
    reviewed_by: null,
    relevant_destinations: [
      'dest_posthog_community_forum'
    ]
  },
  {
    id: 'content_13',
    title: 'Designing Freemium Conversion Experiments in Product-Led SaaS',
    body: 'A/B testing paywall placement, reverse trial incentives, and usage-based threshold notifications to drive subscription upgrades.',
    tags: ['SaaS', 'Product', 'Analytics', 'Founders', 'Growth'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/saas/freemium-conversion',
    reviewed_by: null,
    relevant_destinations: [
      'dest_posthog_community_forum'
    ]
  },
  {
    id: 'content_14',
    title: 'Automating Customer Churn Alerts with Webhooks and Make.com',
    body: 'Connecting subscription cancellation webhooks to customer success Slack channels and trigger follow-up feedback sequences.',
    tags: ['SaaS', 'Automation', 'Workflow', 'Founders'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/saas/churn-alerts',
    reviewed_by: null,
    relevant_destinations: [
      'dest_camunda_process_orchestration_forum',
      'dest_n8n_workflow_forum'
    ]
  },
  {
    id: 'content_15',
    title: 'Automating Internal Ops with Self-Hosted n8n Workflow Queues',
    body: 'Building resilient event-driven background sync pipelines across Postgres, CRM, and Stripe using fair-code n8n nodes.',
    tags: ['Automation', 'Workflow', 'SelfHosted', 'DevOps', 'Engineering'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/n8n-workflows',
    reviewed_by: null,
    relevant_destinations: [
      'dest_n8n_workflow_forum',
      'dest_camunda_process_orchestration_forum'
    ]
  },
  {
    id: 'content_16',
    title: 'Self-Hosted Cloud Collaboration and Document Sharing with Nextcloud',
    body: 'Deploying high-performance Nextcloud instances with Redis caching, Postgres, and end-to-end encrypted storage for remote teams.',
    tags: ['SelfHosted', 'Cloud', 'Collaboration', 'Privacy', 'OpenSource'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/nextcloud-setup',
    reviewed_by: null,
    relevant_destinations: [
      'dest_nextcloud_official_community'
    ]
  },
  {
    id: 'content_17',
    title: 'Product Analytics Event Taxonomy for Complex Multi-Tenant SaaS Apps',
    body: 'Standardizing track/identify schemas and property naming conventions across web and mobile client SDKs.',
    tags: ['SaaS', 'Analytics', 'Engineering', 'Founders'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/saas/analytics-taxonomy',
    reviewed_by: null,
    relevant_destinations: [
      'dest_posthog_community_forum'
    ]
  },
  {
    id: 'content_18',
    title: 'Building Fair-Code Integration Bridges for Custom Webhooks in n8n',
    body: 'Creating custom community nodes in TypeScript to securely sign HMAC payloads and handle backoff retries.',
    tags: ['Automation', 'Workflow', 'Node', 'TypeScript', 'Engineering'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/n8n-custom-nodes',
    reviewed_by: null,
    relevant_destinations: [
      'dest_n8n_workflow_forum',
      'dest_camunda_process_orchestration_forum'
    ]
  },
  {
    id: 'content_19',
    title: 'Managing Enterprise Collaboration Permissions and OAuth2 in Nextcloud',
    body: 'Configuring SSO federated login, LDAP synchronization, and group folder isolation for distributed engineering organizations.',
    tags: ['SelfHosted', 'Security', 'Enterprise', 'Collaboration'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/nextcloud-sso',
    reviewed_by: null,
    relevant_destinations: [
      'dest_nextcloud_official_community'
    ]
  },
  {
    id: 'content_20',
    title: 'Scaling User Activation Funnels: Metrics That Actually Predict Expansion',
    body: 'Analyzing time-to-value, core workflow completion, and activation cohort retention curves using session replays.',
    tags: ['SaaS', 'Analytics', 'Growth', 'Product'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/saas/user-activation',
    reviewed_by: null,
    relevant_destinations: [
      'dest_posthog_community_forum'
    ]
  },

  // 3. Systems Programming, Rust & Developer Tools (10 items)
  {
    id: 'content_21',
    title: 'Zero-Cost Async Concurrency and Memory Safety in Rust 2026',
    body: 'Deep dive into tokio runtimes, pinning, non-blocking I/O, and fearless concurrency patterns for high-throughput networking.',
    tags: ['Rust', 'Systems', 'Performance', 'Backend', 'Engineering'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/rust-async',
    reviewed_by: null,
    relevant_destinations: [
      'dest_rust_users_community_forum'
    ]
  },
  {
    id: 'content_22',
    title: 'Writing Safe FFI Wrappers in Rust for Legacy C Libraries',
    body: 'Preventing undefined behavior, managing struct memory layouts, and handling null pointers across the C/Rust boundary.',
    tags: ['Rust', 'Systems', 'Programming', 'Developers'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/rust-ffi',
    reviewed_by: null,
    relevant_destinations: [
      'dest_rust_users_community_forum'
    ]
  },
  {
    id: 'content_23',
    title: 'Managing High-Concurrency Discourse Community Infrastructure',
    body: 'PostgreSQL tuning, Redis queue optimization, and sidekiq background worker sizing for forums with over 1M monthly visits.',
    tags: ['Discourse', 'DevOps', 'Community', 'Engineering', 'Postgres'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/discourse-infra',
    reviewed_by: null,
    relevant_destinations: [
      'dest_discourse_official_meta_forum'
    ]
  },
  {
    id: 'content_24',
    title: 'Customizing Discourse Theme Components and Plugin APIs in Ruby',
    body: 'Building modular UI widgets, server-side event hooks, and REST webhooks for custom forum integrations.',
    tags: ['Discourse', 'Community', 'Ruby', 'Web', 'Developers'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/discourse-plugins',
    reviewed_by: null,
    relevant_destinations: [
      'dest_discourse_official_meta_forum'
    ]
  },
  {
    id: 'content_25',
    title: 'Memory Profiling and Leak Detection in Long-Running Rust Daemons',
    body: 'Using Valgrind, heaptrack, and jemalloc statistics to isolate memory fragmentation in embedded Linux systems.',
    tags: ['Rust', 'Systems', 'DevOps', 'Performance', 'Linux'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/rust-profiling',
    reviewed_by: null,
    relevant_destinations: [
      'dest_rust_users_community_forum'
    ]
  },
  {
    id: 'content_26',
    title: 'High-Throughput SIMD Vectorization in Rust for Audio and Signal Processing',
    body: 'Utilizing std::simd portable intrinsics to accelerate audio DSP filtering and matrix operations on x86 and ARM.',
    tags: ['Rust', 'Systems', 'Performance', 'Audio', 'Engineering'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/rust-simd',
    reviewed_by: null,
    relevant_destinations: [
      'dest_rust_users_community_forum'
    ]
  },
  {
    id: 'content_27',
    title: 'Discourse Community Moderation Automation: Trust Levels and Auto-Silencing',
    body: 'Configuring trust-level thresholds, Akismet spam checks, and automated community moderation heuristics.',
    tags: ['Discourse', 'Community', 'Moderation', 'Management'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/community/discourse-moderation',
    reviewed_by: null,
    relevant_destinations: [
      'dest_discourse_official_meta_forum'
    ]
  },
  {
    id: 'content_28',
    title: 'Compile-Time Metaprogramming with Rust Procedural Macros',
    body: 'Authoring custom derive macros and attribute injectors using syn and quote crates for domain-specific serialization.',
    tags: ['Rust', 'Programming', 'Developers', 'Engineering'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/rust-proc-macros',
    reviewed_by: null,
    relevant_destinations: [
      'dest_rust_users_community_forum'
    ]
  },
  {
    id: 'content_29',
    title: 'Building Enterprise SSO and Identity Providers for Discourse Meta',
    body: 'Integrating DiscourseConnect, SAML, and OAuth2 authentication across corporate intranet platforms.',
    tags: ['Discourse', 'Security', 'Enterprise', 'Identity'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/discourse-sso',
    reviewed_by: null,
    relevant_destinations: [
      'dest_discourse_official_meta_forum'
    ]
  },
  {
    id: 'content_30',
    title: 'Developing Fast Cross-Platform CLI Tools in Rust with Clap and Crossterm',
    body: 'Designing beautiful terminal interactive prompts, progress spinners, and colored logs for developer utilities.',
    tags: ['Rust', 'CLI', 'Tools', 'Developers'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/rust-cli',
    reviewed_by: null,
    relevant_destinations: [
      'dest_rust_users_community_forum'
    ]
  },

  // 4. Video, 3D Graphics & Media Transcoding (10 items)
  {
    id: 'content_31',
    title: 'Photorealistic Cycles Rendering Workflows in Blender 4.x',
    body: 'Optimizing light paths, denoising algorithms, and GPU compute performance for architectural visualization and animations.',
    tags: ['Video', '3D', 'Blender', 'Animation', 'Creators'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/creators/blender-rendering',
    reviewed_by: null,
    relevant_destinations: [
      'dest_blender_artists_community',
      'dest_mcneel_rhino_grasshopper_3d_forum'
    ]
  },
  {
    id: 'content_32',
    title: 'Automated Video Transcoding and Packaging Pipelines with FFmpeg',
    body: 'Generating adaptive bitrate HLS streams, MP4 fallback enclosures, and WebVTT captions for video podcast syndication.',
    tags: ['Video', 'Media', 'Transcoding', 'DevOps', 'Streaming'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/ffmpeg-transcoding',
    reviewed_by: null,
    relevant_destinations: [
      'dest_plex_media_server_community',
      'dest_blender_artists_community'
    ]
  },
  {
    id: 'content_33',
    title: 'Procedural Shader Generation in Blender Geometry Nodes',
    body: 'Constructing dynamic node trees for weathering, terrain generation, and procedural particle animations.',
    tags: ['3D', 'Blender', 'Animation', 'Creators'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/creators/geometry-nodes',
    reviewed_by: null,
    relevant_destinations: [
      'dest_blender_artists_community',
      'dest_mcneel_rhino_grasshopper_3d_forum'
    ]
  },
  {
    id: 'content_34',
    title: 'Generative AI Video Workflows with ComfyUI and ControlNet',
    body: 'Building node-based prompt workflows and frame interpolation pipelines for AI animators and video creators.',
    tags: ['Video', 'AI', 'ComfyUI', 'Creators', 'Animation'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/comfyui-video',
    reviewed_by: null,
    relevant_destinations: [
      'dest_comfyui_generative_workflow_creators',
      'dest_discord_midjourney_video_animators_hub',
      'dest_discord_runway_gen_2_gen_3_creators'
    ]
  },
  {
    id: 'content_35',
    title: 'Generative Video Diffusion Models: Runway Gen-3 Prompting Masterclass',
    body: 'Camera motion controls, motion brush dynamics, and temporal consistency techniques for cinematic AI generation.',
    tags: ['Video', 'AI', 'Creators', 'Animation'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/creators/runway-video',
    reviewed_by: null,
    relevant_destinations: [
      'dest_discord_runway_gen_2_gen_3_creators',
      'dest_discord_midjourney_video_animators_hub'
    ]
  },
  {
    id: 'content_36',
    title: 'AI Animation Prompts and Style Coherence with Midjourney',
    body: 'Guiding stylized character aesthetics across keyframes for animation storyboards and short films.',
    tags: ['Video', 'Animation', 'AI', 'Art'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/creators/midjourney-animation',
    reviewed_by: null,
    relevant_destinations: [
      'dest_discord_midjourney_video_animators_hub',
      'dest_discord_runway_gen_2_gen_3_creators'
    ]
  },
  {
    id: 'content_37',
    title: 'Interactive 3D Web Graphics with Three.js and WebGL Shaders',
    body: 'Setting up custom GLSL fragment shaders, lighting models, and physics engines inside the browser canvas.',
    tags: ['3D', 'WebGL', 'JavaScript', 'Developers'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/creators/threejs-shaders',
    reviewed_by: null,
    relevant_destinations: [
      'dest_three_js_3d_webgl_forum',
      'dest_blender_artists_community'
    ]
  },
  {
    id: 'content_38',
    title: 'Game Development and Scene Architecture in Godot Engine',
    body: 'Scripting scene trees, 2D physics layers, and cross-platform export configurations in GDScript.',
    tags: ['3D', 'GameDev', 'Godot', 'Developers'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/tech/godot-architecture',
    reviewed_by: null,
    relevant_destinations: [
      'dest_godot_game_engine_forum'
    ]
  },
  {
    id: 'content_39',
    title: 'Parametric CAD Modeling and Technical Design in FreeCAD',
    body: 'Drafting parametric parts, constraint solvers, and technical assembly blueprints with open-source tools.',
    tags: ['3D', 'CAD', 'Engineering', 'OpenSource'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/creators/freecad-modeling',
    reviewed_by: null,
    relevant_destinations: [
      'dest_freecad_engineering_forum'
    ]
  },
  {
    id: 'content_40',
    title: 'Creating Stylized NPR (Non-Photorealistic) Shaders in Blender',
    body: 'Toon shading, rim lighting, and grease pencil line art workflows for anime-inspired 3D productions.',
    tags: ['3D', 'Blender', 'Animation', 'Art'],
    language: 'en',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/creators/toon-shading',
    reviewed_by: null,
    relevant_destinations: [
      'dest_blender_artists_community',
      'dest_babylon_js_3d_webgl_engine_forum'
    ]
  },

  // 5. Localized Regional Communities (French, Spanish, Portuguese, Japanese, Dutch, Chinese) (10 items)
  {
    id: 'content_41',
    title: 'Optimisation SEO et architectures web modernes pour développeurs francophones',
    body: 'Guide pratique sur l\'indexation sémantique, les balises canoniques et le rendu côté serveur avec Next.js et Astro.',
    tags: ['French', 'Web', 'SEO', 'JavaScript', 'Developers'],
    language: 'fr',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/fr/seo-web-moderne',
    reviewed_by: null,
    relevant_destinations: [
      'dest_developpez_french_engineering_forum',
      'dest_linuxfr_french_tech_portal'
    ]
  },
  {
    id: 'content_42',
    title: 'Déployer des services libres et décentralisés avec la communauté LinuxFR',
    body: 'Guide de souveraineté numérique et d\'hébergement éthique utilisant des conteneurs légers et logiciels ouverts.',
    tags: ['French', 'OpenSource', 'SelfHosted', 'Linux'],
    language: 'fr',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/fr/services-libres',
    reviewed_by: null,
    relevant_destinations: [
      'dest_linuxfr_french_tech_portal',
      'dest_developpez_french_engineering_forum'
    ]
  },
  {
    id: 'content_43',
    title: 'Desarrollo web moderno y posicionamiento SEO técnico en comunidades de habla hispana',
    body: 'Técnicas avanzadas de optimización de Core Web Vitals, estructuración de datos JSON-LD y frameworks reactivos.',
    tags: ['Spanish', 'Web', 'SEO', 'Developers', 'Frontend'],
    language: 'es',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/es/seo-tecnico',
    reviewed_by: null,
    relevant_destinations: [
      'dest_forosdelweb_spanish_webdev_forum',
      'dest_platzi_spanish_tech_community'
    ]
  },
  {
    id: 'content_44',
    title: 'Estrategias de aprendizaje técnico y desarrollo profesional con Platzi',
    body: 'Rutas de formación en desarrollo de software, inteligencia artificial y habilidades para startups en Latinoamérica.',
    tags: ['Spanish', 'Tech', 'Startups', 'Developers'],
    language: 'es',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/es/aprendizaje-platzi',
    reviewed_by: null,
    relevant_destinations: [
      'dest_platzi_spanish_tech_community',
      'dest_forosdelweb_spanish_webdev_forum'
    ]
  },
  {
    id: 'content_45',
    title: 'Arquitetura de microsserviços e desenvolvimento de software no ecossistema brasileiro',
    body: 'Boas práticas de engenharia de software, mensageria assíncrona com RabbitMQ e segurança de APIs em produção.',
    tags: ['Portuguese', 'Programming', 'Backend', 'Developers', 'Architecture'],
    language: 'pt',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/pt/arquitetura-microsservicos',
    reviewed_by: null,
    relevant_destinations: [
      'dest_tabnews_portuguese_tech_community'
    ]
  },
  {
    id: 'content_46',
    title: 'Desenvolvimento ágil e boas práticas de código limpo no TabNews',
    body: 'Refatoração contínua, testes automatizados e cultura DevOps para programadores e criadores de conteúdo.',
    tags: ['Portuguese', 'Developers', 'Programming', 'DevOps'],
    language: 'pt',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/pt/codigo-limpo',
    reviewed_by: null,
    relevant_destinations: [
      'dest_tabnews_portuguese_tech_community'
    ]
  },
  {
    id: 'content_47',
    title: 'TypeScriptとNext.jsによるモダンなフロントエンド開発とパフォーマンス最適化',
    body: 'App Router、Server Components、キャッシュ戦略を活用した堅牢なウェブアプリケーション設計パターン。',
    tags: ['Japanese', 'TypeScript', 'React', 'Frontend', 'Developers'],
    language: 'ja',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ja/frontend-optimization',
    reviewed_by: null,
    relevant_destinations: [
      'dest_zenn_japanese_developer_knowledge_hub',
      'dest_qiita_japanese_tech_network'
    ]
  },
  {
    id: 'content_48',
    title: 'Qiitaコミュニティにおけるエンジニアリング知識共有と技術ブログ執筆',
    body: '高品質な技術記事の書き方、コード解説、開発現場におけるTipsの共有ベストプラクティス。',
    tags: ['Japanese', 'Developers', 'Engineering', 'Knowledge'],
    language: 'ja',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/ja/qiita-tips',
    reviewed_by: null,
    relevant_destinations: [
      'dest_qiita_japanese_tech_network',
      'dest_zenn_japanese_developer_knowledge_hub'
    ]
  },
  {
    id: 'content_49',
    title: 'Nederlandse tech community inzichten in IT-infrastructuur en hardwarekeuzes',
    body: 'Analyse van serverhardware, energie-efficiënte thuisoplossingen en netwerkbeveiliging voor professionals.',
    tags: ['Dutch', 'Hardware', 'Networking', 'Security', 'IT'],
    language: 'nl',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/nl/it-infrastructuur',
    reviewed_by: null,
    relevant_destinations: [
      'dest_tweakers_dutch_tech_community'
    ]
  },
  {
    id: 'content_50',
    title: 'V2EX社区讨论：面向全栈工程师的分布式系统架构与高并发实践',
    body: '探讨高可用微服务、缓存穿透防护、分布式事务方案以及大规模数据处理实践。',
    tags: ['Chinese', 'Architecture', 'Distributed', 'Backend', 'Developers'],
    language: 'zh',
    is_promotional: false,
    canonical_url: 'https://incubrix.internal/zh/distributed-systems',
    reviewed_by: null,
    relevant_destinations: [
      'dest_v2ex_chinese_tech_community'
    ]
  }
];

// Validate all destination IDs
console.log(`Validating ${items.length} items against catalogue destination IDs...`);
let allValid = true;

for (const item of items) {
  for (const destId of item.relevant_destinations) {
    if (!validDestMap.has(destId)) {
      console.error(`ERROR: Item ${item.id} references non-existent destination ID: '${destId}'`);
      allValid = false;
    }
  }
}

if (!allValid) {
  console.error('Validation failed! Aborting.');
  process.exit(1);
}

console.log('All 50 items verified against real catalogue destination IDs!');

const dataset = {
  _metadata: {
    status: 'draft_needs_human_review',
    notice: 'DRAFT - NEEDS HUMAN REVIEW: Curated 50-item evaluation set with verified destination IDs from the real catalogue. Requires domain specialist review; reviewed_by left null per instructions.',
    evaluation_metric: 'Precision@10 and Recall',
    target_verticals: ['AI & LLMs', 'SaaS & Analytics', 'Systems & Rust', 'Video & 3D Creators', 'Localized & Regional'],
    total_items: items.length,
    reviewed_by: null,
    created_at: new Date().toISOString(),
    version: '2.0.0'
  },
  items
};

const outputPath = path.join(projectRoot, 'data', 'labelled_recommender_set.json');
fs.writeFileSync(outputPath, JSON.stringify(dataset, null, 2), 'utf8');
console.log(`Successfully wrote ${items.length} validated items to ${outputPath}`);
