import { HttpAdapter } from "../http";
import {
  createMetadataRegistry,
  type MetadataRegistry,
} from "../core/metadata";
import { Container } from "../di";
import {
  BackgroundScheduler,
  AuthorizationService,
  ErrorPipeline,
  ApplicationEvents,
} from "../runtime";
import { OpenApiDocumentBuilder } from "../openapi";
import { PostgresExecutor, QueryRegistry } from "../sql";
import { ApplicationLifecycle } from "./lifecycle/lifecycle";
import { HealthCheckRegistry } from "./lifecycle/health-checks";
import { ApplicationLogger } from "../utils/logger";

export class ApplicationContext {
  readonly http: HttpAdapter;
  readonly container: Container;
  readonly metadata: MetadataRegistry;
  readonly lifecycle: ApplicationLifecycle;
  readonly postgres: PostgresExecutor;
  readonly queries: QueryRegistry;
  readonly background: BackgroundScheduler;
  readonly errors: ErrorPipeline;
  readonly authorization: AuthorizationService;
  readonly openApi: OpenApiDocumentBuilder;
  readonly healthChecks: HealthCheckRegistry;
  readonly logger: ApplicationLogger;
  readonly events: ApplicationEvents;

  constructor(container = new Container()) {
    this.http = new HttpAdapter();
    this.container = container;
    this.metadata = createMetadataRegistry();
    this.lifecycle = new ApplicationLifecycle();
    this.postgres = new PostgresExecutor();
    this.queries = new QueryRegistry();
    this.background = new BackgroundScheduler();
    this.errors = new ErrorPipeline();
    this.authorization = new AuthorizationService();
    this.openApi = new OpenApiDocumentBuilder();
    this.healthChecks = new HealthCheckRegistry();
    this.logger = new ApplicationLogger();
    this.events = new ApplicationEvents();
    this.events.setLogger(this.logger);
    this.http.setLogger(this.logger);
    this.http.setEvents(this.events);
    this.background.setLogger(this.logger);
    this.background.setEvents(this.events);
  }
}
