import { HttpAdapter } from "../http";
import { createMetadataRegistry, type MetadataRegistry } from "../metadata";
import { Container } from "../di";
import {
  BackgroundScheduler,
  AuthorizationService,
  ErrorPipeline,
} from "../runtime";
import { OpenApiDocumentBuilder } from "../openapi";
import { PostgresExecutor, QueryRegistry } from "../sql";
import { ApplicationLifecycle } from "./lifecycle";
import { HealthCheckRegistry } from "./health-checks";
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
  readonly pluginServices: Map<string, unknown>;
  readonly logger: ApplicationLogger;

  constructor() {
    this.http = new HttpAdapter();
    this.container = new Container();
    this.metadata = createMetadataRegistry();
    this.lifecycle = new ApplicationLifecycle();
    this.postgres = new PostgresExecutor();
    this.queries = new QueryRegistry();
    this.background = new BackgroundScheduler();
    this.errors = new ErrorPipeline();
    this.authorization = new AuthorizationService();
    this.openApi = new OpenApiDocumentBuilder();
    this.healthChecks = new HealthCheckRegistry();
    this.pluginServices = new Map();
    this.logger = new ApplicationLogger();
    this.http.setLogger(this.logger);
    this.background.setLogger(this.logger);
  }
}
